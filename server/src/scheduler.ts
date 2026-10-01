import { prisma } from "./db.js";
import { nodeTest, pingCheck } from "./steps.js";

// In-process, DB-driven check scheduler. One staggered timer per enabled
// target; rescheduled after every tick and after any target CRUD.
// Started explicitly from the server entry point (never in tests).

const timers = new Map<string, NodeJS.Timeout>();
let pruneTimer: NodeJS.Timeout | null = null;
let nodeTimer: NodeJS.Timeout | null = null;

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly
const NODE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function tick(targetId: string): Promise<void> {
  const target = await prisma.pingTarget.findUnique({ where: { id: targetId } });
  if (!target?.enabled) return;
  await pingCheck(target);
  schedule(target, target.intervalSec * 1000);
}

function schedule(target: { id: string }, delayMs: number): void {
  clearTimeout(timers.get(target.id));
  const timer = setTimeout(() => void tick(target.id), delayMs);
  timer.unref();
  timers.set(target.id, timer);
}

/** (Re)schedule one target, e.g. after CRUD. Pass enabled=false to stop it. */
export async function scheduleTarget(targetId: string): Promise<void> {
  clearTimeout(timers.get(targetId));
  timers.delete(targetId);
  const target = await prisma.pingTarget.findUnique({ where: { id: targetId } });
  if (target?.enabled) schedule(target, 0); // first check immediately
}

export async function startScheduler(): Promise<void> {
  const targets = await prisma.pingTarget.findMany({ where: { enabled: true } });
  targets.forEach((t, i) => void schedule(t, i * 2000)); // stagger startup probes
  pruneTimer = setInterval(pruneOldResults, PRUNE_INTERVAL_MS);
  pruneTimer.unref();
  nodeTimer = setInterval(checkAllNodes, NODE_CHECK_INTERVAL_MS);
  nodeTimer.unref();
  void checkAllNodes();
}

async function checkAllNodes(): Promise<void> {
  const nodes = await prisma.node.findMany({ orderBy: { name: "asc" } });
  for (const node of nodes) {
    await nodeTest(node); // audited per node; status recorded on the row
  }
}

export function stopScheduler(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  clearInterval(pruneTimer ?? undefined);
  clearInterval(nodeTimer ?? undefined);
  pruneTimer = null;
  nodeTimer = null;
}

async function pruneOldResults(): Promise<void> {
  await prisma.checkResult.deleteMany({
    where: { at: { lt: new Date(Date.now() - RETENTION_MS) } },
  });
}
