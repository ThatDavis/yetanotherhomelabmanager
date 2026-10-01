import type { Host } from "@prisma/client";
import { prisma } from "./db.js";
import { containerUpdate, type OsUpdateData, osUpdate } from "./updates.js";

// Job runner (M3.1). One job runs at a time (rolling updates); a manual run
// while another job is active waits in the queue. State lives in the DB —
// Job/JobStep rows — so the job center renders history and the SSE stream
// only carries liveness. Every step already audits itself via runStep.

type StepFn = (host: Host) => ReturnType<typeof osUpdate>;

const PLANNED_STEPS: { name: string; toggle: "osUpdates" | "containerUpdates"; fn: StepFn }[] = [
  { name: "os.update", toggle: "osUpdates", fn: osUpdate },
  { name: "container.update", toggle: "containerUpdates", fn: containerUpdate },
];

let running = false;
const queue: string[] = [];

/** Create a Job row for a schedule and enqueue it. Returns the job id. */
export async function enqueueUpdateJob(
  scheduleId: string,
  trigger: "scheduled" | "manual",
): Promise<string> {
  const job = await prisma.job.create({ data: { trigger, scheduleId } });
  queue.push(job.id);
  void pump();
  return job.id;
}

async function pump(): Promise<void> {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  running = true;
  try {
    await runJob(next);
  } finally {
    running = false;
    void pump();
  }
}

async function runJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    include: { schedule: { include: { hosts: { orderBy: { alias: "asc" } } } } },
  });
  const schedule = job.schedule;
  if (!schedule) {
    await fail(jobId, "schedule was deleted before the job ran");
    return;
  }

  emit(jobId, "status", { status: "running" });
  let allOk = true;
  const steps = PLANNED_STEPS.filter((s) => schedule[s.toggle]);
  for (const host of schedule.hosts) {
    for (const step of steps) {
      emit(jobId, "step-start", { host: host.alias, name: step.name });
      const result = await step.fn(host);
      const rebootPending = (result.data as OsUpdateData | undefined)?.rebootPending ?? false;
      const stepRow = await prisma.jobStep.create({
        data: {
          jobId,
          hostId: host.id,
          name: step.name,
          ok: result.ok,
          output: result.output,
          rebootPending,
          durationMs: result.durationMs,
        },
      });
      emit(jobId, "step", stepRow);
      if (!result.ok) allOk = false; // per-host isolation: keep going
    }
  }

  const status = allOk ? "succeeded" : "failed";
  await prisma.job.update({ where: { id: jobId }, data: { status, finishedAt: new Date() } });
  if (job.trigger === "scheduled") {
    await prisma.updateSchedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date() },
    });
  }
  emit(jobId, "status", { status });
}

async function fail(jobId: string, output: string): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "failed", finishedAt: new Date() },
  });
  emit(jobId, "status", { status: "failed", output });
}

// --- SSE hub: one fan-out per job id ---

type Listener = (event: string, data: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

function emit(jobId: string, event: string, data: unknown): void {
  for (const listener of listeners.get(jobId) ?? []) listener(event, data);
}

/** Subscribe to a job's live events. Returns an unsubscribe function. */
export function subscribeJob(jobId: string, listener: Listener): () => void {
  let set = listeners.get(jobId);
  if (!set) {
    set = new Set();
    listeners.set(jobId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(jobId);
  };
}

/** Test hook: wait until the queue drains (all enqueued jobs finish). */
export async function drainQueue(): Promise<void> {
  while (running || queue.length > 0) await new Promise((r) => setTimeout(r, 25));
}
