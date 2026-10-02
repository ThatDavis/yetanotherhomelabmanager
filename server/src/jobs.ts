import type { Host } from "@prisma/client";
import { audit } from "./audit.js";
import { prisma } from "./db.js";
import { containerUpdate, hostReboot, type OsUpdateData, osUpdate } from "./updates.js";

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

/** Create a reboot Job over an explicit host set and enqueue it. */
export async function enqueueRebootJob(
  hostIds: string[],
  trigger: "manual" | "auto",
  scheduleId?: string,
): Promise<string> {
  const job = await prisma.job.create({
    data: {
      kind: "reboot",
      trigger,
      ...(scheduleId !== undefined ? { scheduleId } : {}),
      hosts: { connect: hostIds.map((id) => ({ id })) },
    },
  });
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
  } catch (err) {
    // Steps return ok:false for expected failures; a throw here is a bug.
    // Fail the job instead of dying with it stuck "running".
    await fail(next, `runner: ${(err as Error).message}`);
  } finally {
    running = false;
    void pump();
  }
}

async function runJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    include: {
      schedule: { include: { hosts: { orderBy: { alias: "asc" } } } },
      hosts: true,
    },
  });
  if (job.kind === "reboot") {
    await runRebootRoll(job.id, job.hosts);
    return;
  }
  const schedule = job.schedule;
  if (!schedule) {
    await fail(jobId, "schedule was deleted before the job ran");
    return;
  }

  emit(jobId, "status", { status: "running" });
  let allOk = true;
  const pendingReboot = new Set<string>();
  const steps = PLANNED_STEPS.filter((s) => schedule[s.toggle]);
  for (const host of schedule.hosts) {
    for (const step of steps) {
      emit(jobId, "step-start", { host: host.alias, name: step.name });
      const result = await step.fn(host);
      const rebootPending = (result.data as OsUpdateData | undefined)?.rebootPending ?? false;
      if (rebootPending) pendingReboot.add(host.id);
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
  await finishJob(jobId, status);
  if (job.trigger === "scheduled") {
    try {
      await prisma.updateSchedule.update({
        where: { id: schedule.id },
        data: { lastRunAt: new Date() },
      });
    } catch {
      // schedule deleted mid-job
    }
  }
  emit(jobId, "status", { status });

  // Opt-in reboot roll: reboot hosts the updates flagged, in boot order.
  if (schedule.rebootAfterUpdate) {
    await scheduleRebootRoll(job, schedule.id, schedule.hosts, pendingReboot);
  }
}

// Self hosts are never auto-rebooted (the orchestrator would kill itself);
// the skip is audited so the operator sees it in the job trail.
async function scheduleRebootRoll(
  job: { id: string; trigger: string },
  scheduleId: string,
  hosts: Host[],
  pendingReboot: Set<string>,
): Promise<void> {
  const roll: string[] = [];
  for (const host of hosts) {
    if (!pendingReboot.has(host.id)) continue;
    if (host.self) {
      await audit({
        action: "host.reboot",
        target: host.alias,
        ok: true,
        output: "skipped: self host — reboot refused; reboot it manually",
      });
      continue;
    }
    roll.push(host.id);
  }
  if (roll.length > 0) {
    await enqueueRebootJob(roll, job.trigger === "manual" ? "manual" : "auto", scheduleId);
  }
}

// Rolling reboot (M3.2): hosts go down one at a time, low bootOrder first;
// a host must come back before the next one reboots. A failed recovery
// aborts the roll — already-rebooted hosts are not re-touched.
async function runRebootRoll(jobId: string, hosts: Host[]): Promise<void> {
  const ordered = [...hosts].sort(
    (a, b) => a.bootOrder - b.bootOrder || a.alias.localeCompare(b.alias),
  );
  emit(jobId, "status", { status: "running" });
  for (const host of ordered) {
    emit(jobId, "step-start", { host: host.alias, name: "host.reboot" });
    const result = await hostReboot(host);
    const stepRow = await prisma.jobStep.create({
      data: {
        jobId,
        hostId: host.id,
        name: "host.reboot",
        ok: result.ok,
        output: result.output,
        durationMs: result.durationMs,
      },
    });
    emit(jobId, "step", stepRow);
    if (!result.ok) {
      const remaining = ordered.length - ordered.indexOf(host) - 1;
      await finishJob(
        jobId,
        "failed",
        `roll aborted: ${host.alias} did not recover; ${remaining} host(s) skipped`,
      );
      return;
    }
  }
  await finishJob(jobId, "succeeded");
  emit(jobId, "status", { status: "succeeded" });
}

// P2025 = the job row was deleted mid-run (same deleted-mid-check race as
// ping.check, M2.1) — nothing left to update, so quiet success.
async function finishJob(jobId: string, status: string, output?: string): Promise<void> {
  try {
    await prisma.job.update({
      where: { id: jobId },
      data: { status, finishedAt: new Date() },
    });
    if (output) emit(jobId, "status", { status, output });
  } catch {
    // deleted mid-job
  }
}

async function fail(jobId: string, output: string): Promise<void> {
  await finishJob(jobId, "failed", output);
}

// --- SSE hub: one fan-out per job id, plus a global stream for toasts ---

type Listener = (event: string, data: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
const globalListeners = new Set<Listener>();

function emit(jobId: string, event: string, data: unknown): void {
  for (const listener of listeners.get(jobId) ?? []) listener(event, data);
  for (const listener of globalListeners) listener(event, { jobId, ...((data as object) ?? {}) });
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

/** Subscribe to every job's live events (job-toast fan-out). */
export function subscribeAllJobs(listener: Listener): () => void {
  globalListeners.add(listener);
  return () => globalListeners.delete(listener);
}

/** Test hook: wait until the queue drains (all enqueued jobs finish). */
export async function drainQueue(): Promise<void> {
  while (running || queue.length > 0) await new Promise((r) => setTimeout(r, 25));
}
