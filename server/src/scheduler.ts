import { prisma } from "./db.js";
import { enqueueUpdateJob } from "./jobs.js";
import { osCheck, stacksScan } from "./stacks.js";
import { nodeTest, pingCheck } from "./steps.js";

// In-process, DB-driven check scheduler. One staggered timer per enabled
// target; rescheduled after every tick and after any target CRUD.
// Update schedules are checked on a fixed tick against day-of-week + time.
// Started explicitly from the server entry point (never in tests).

const timers = new Map<string, NodeJS.Timeout>();
let pruneTimer: NodeJS.Timeout | null = null;
let nodeTimer: NodeJS.Timeout | null = null;
let updateTimer: NodeJS.Timeout | null = null;
let nightlyTimer: NodeJS.Timeout | null = null;

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly
const NODE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const UPDATE_TICK_MS = 30 * 1000; // 30 seconds
const NIGHTLY_TICK_MS = 30 * 60 * 1000; // 30 minutes
const NIGHTLY_HOUR = 3; // 03:00–03:59 server-local
let updateTickRunning = false;
let lastNightlyDate = "";

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
  updateTimer = setInterval(() => void checkUpdateSchedules(), UPDATE_TICK_MS);
  updateTimer.unref();
  void checkUpdateSchedules();
  nightlyTimer = setInterval(() => {
    if (new Date().getHours() === NIGHTLY_HOUR) void runNightlyScans();
  }, NIGHTLY_TICK_MS);
  nightlyTimer.unref();
}

// Nightly inventory (M3.6): every host gets a stack scan; hosts in an
// enabled update schedule's scope also get the OS pending-count check.
// Results are cached in DB so dashboards never block on SSH. Guarded to
// once per day; exported for tests.
export async function runNightlyScans(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (lastNightlyDate === today) return;
  lastNightlyDate = today;
  const schedules = await prisma.updateSchedule.findMany({
    where: { enabled: true },
    include: { hosts: { select: { id: true } } },
  });
  const osHostIds = new Set(schedules.flatMap((s) => s.hosts.map((h) => h.id)));
  const hosts = await prisma.host.findMany({ orderBy: { alias: "asc" } });
  for (const host of hosts) {
    await stacksScan(host);
    if (osHostIds.has(host.id)) await osCheck(host);
  }
}

// Fire every enabled schedule whose day+time matches now and that has not run
// yet today (scheduled runs stamp lastRunAt when the job finishes).
export async function checkUpdateSchedules(): Promise<void> {
  if (updateTickRunning) return;
  updateTickRunning = true;
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const due = await prisma.updateSchedule.findMany({
      where: { enabled: true, daysOfWeek: { has: now.getDay() }, timeOfDay: hhmm },
    });
    for (const schedule of due) {
      if (schedule.lastRunAt && schedule.lastRunAt >= today) continue;
      await prisma.updateSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: now } });
      await enqueueUpdateJob(schedule.id, "scheduled");
    }
  } finally {
    updateTickRunning = false;
  }
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
  clearInterval(updateTimer ?? undefined);
  clearInterval(nightlyTimer ?? undefined);
  pruneTimer = null;
  nodeTimer = null;
  updateTimer = null;
  nightlyTimer = null;
}

async function pruneOldResults(): Promise<void> {
  await prisma.checkResult.deleteMany({
    where: { at: { lt: new Date(Date.now() - RETENTION_MS) } },
  });
}
