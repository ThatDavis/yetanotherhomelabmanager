import "./env.js";
import { afterEach, expect, test, vi } from "vitest";
import { buildServer } from "../src/app.js";
import { prisma } from "../src/db.js";
import { execOnHost } from "../src/executor.js";
import { drainQueue, enqueueRebootJob, enqueueUpdateJob } from "../src/jobs.js";
import { hostReboot } from "../src/updates.js";

vi.mock("../src/executor.js", () => ({
  execOnHost: vi.fn(),
}));

// Roll tests exercise ordering/abort logic, not reboot internals —
// host.reboot itself is covered in updates.test.ts.
vi.mock("../src/updates.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/updates.js")>();
  return { ...actual, hostReboot: vi.fn() };
});

const execMock = vi.mocked(execOnHost);
const rebootMock = vi.mocked(hostReboot);
const app = buildServer({ spaDir: "/nonexistent", auth: false });

let hostId = "";

async function makeSchedule(overrides: { osUpdates?: boolean; containerUpdates?: boolean } = {}) {
  const schedule = await prisma.updateSchedule.create({
    data: {
      name: `test-job-${Date.now()}`,
      daysOfWeek: [1],
      timeOfDay: "03:00",
      osUpdates: overrides.osUpdates ?? true,
      containerUpdates: overrides.containerUpdates ?? true,
      hosts: { connect: { id: hostId } },
    },
  });
  return schedule;
}

afterEach(async () => {
  execMock.mockReset();
  rebootMock.mockReset();
  await prisma.jobStep.deleteMany({
    where: { job: { schedule: { name: { startsWith: "test-job-" } } } },
  });
  await prisma.job.deleteMany({ where: { schedule: { name: { startsWith: "test-job-" } } } });
  await prisma.job.deleteMany({ where: { scheduleId: null } });
  await prisma.updateSchedule.deleteMany({ where: { name: { startsWith: "test-job-" } } });
  await prisma.host.deleteMany({ where: { alias: { startsWith: "test-jobhost-" } } });
  await prisma.auditEntry.deleteMany({ where: { target: { startsWith: "test-jobhost-" } } });
});

const COMPOSE_LS = JSON.stringify([{ Name: "web", ConfigFiles: "/srv/web/compose.yml" }]);

// All-positive executor: apt host, docker with one compose project.
function mockAllOk() {
  execMock.mockImplementation(async (_h, command: string) => {
    if (command.startsWith("for c in apt-get")) {
      return { ok: true, output: "/usr/bin/apt-get", exitCode: 0, lines: [] };
    }
    if (command === "docker compose ls --all --format json")
      return { ok: true, output: COMPOSE_LS, exitCode: 0, lines: [] };
    return { ok: true, output: "ok", exitCode: 0, lines: [] };
  });
}

test("job runs planned steps per host, persists steps, and succeeds", async () => {
  const host = await prisma.host.create({
    data: { alias: `test-jobhost-${Date.now()}`, hostname: "192.0.2.30", username: "root" },
  });
  hostId = host.id;
  mockAllOk();
  const schedule = await makeSchedule();
  const jobId = await enqueueUpdateJob(schedule.id, "manual");
  await drainQueue();

  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    include: { steps: { orderBy: { startedAt: "asc" } } },
  });
  expect(job.status).toBe("succeeded");
  expect(job.steps.map((s) => s.name)).toEqual(["os.update", "container.update"]);
  expect(job.steps.every((s) => s.ok)).toBe(true);
  // manual run does not touch lastRunAt
  const after = await prisma.updateSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
  expect(after.lastRunAt).toBeNull();
});

test("one host failing does not stop the job; job reports failed", async () => {
  const good = await prisma.host.create({
    data: { alias: `test-jobhost-good-${Date.now()}`, hostname: "192.0.2.31", username: "root" },
  });
  const bad = await prisma.host.create({
    data: { alias: `test-jobhost-bad-${Date.now()}`, hostname: "192.0.2.32", username: "root" },
  });
  hostId = good.id;
  const schedule = await prisma.updateSchedule.create({
    data: {
      name: `test-job-${Date.now()}`,
      daysOfWeek: [1],
      timeOfDay: "03:00",
      osUpdates: true,
      containerUpdates: false,
      hosts: { connect: [{ id: good.id }, { id: bad.id }] },
    },
  });
  execMock.mockImplementation(async (h) => {
    if (h.alias.startsWith("test-jobhost-bad")) {
      return { ok: false, output: "! unreachable", exitCode: null, lines: [] };
    }
    return { ok: true, output: "ok", exitCode: 0, lines: [] };
  });

  const jobId = await enqueueUpdateJob(schedule.id, "scheduled");
  await drainQueue();
  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    include: { steps: true },
  });
  expect(job.status).toBe("failed");
  expect(job.steps).toHaveLength(2); // both hosts got their step
  const after = await prisma.updateSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
  expect(after.lastRunAt).not.toBeNull(); // scheduled run records lastRunAt
});

test("jobs API lists jobs and streams SSE events", async () => {
  const host = await prisma.host.create({
    data: { alias: `test-jobhost-${Date.now()}`, hostname: "192.0.2.33", username: "root" },
  });
  hostId = host.id;
  mockAllOk();
  const schedule = await makeSchedule({ containerUpdates: false });
  const jobId = await enqueueUpdateJob(schedule.id, "manual");
  await drainQueue();

  const list = await app.inject({ method: "GET", url: "/api/jobs" });
  expect(list.statusCode).toBe(200);
  expect(list.json().some((j: { id: string }) => j.id === jobId)).toBe(true);

  const detail = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
  expect(detail.json().steps).toHaveLength(1);

  const missing = await app.inject({ method: "GET", url: "/api/jobs/nope/events" });
  expect(missing.statusCode).toBe(404);

  // SSE never ends — inject would hang; listen for real and abort after the
  // first events arrive. The server sends a subscription status immediately.
  const sseApp = buildServer({ spaDir: "/nonexistent", auth: false });
  await sseApp.listen({ port: 0, host: "127.0.0.1" });
  const address = sseApp.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    if (!res.body) throw new Error("SSE response has no body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("event: status")) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }
    expect(received).toContain("event: status");
    controller.abort();
    reader.cancel().catch(() => {});

    // Global stream: same shape, no job id needed.
    const gres = await fetch(`http://127.0.0.1:${port}/api/jobs/events`);
    expect(gres.status).toBe(200);
    if (!gres.body) throw new Error("SSE response has no body");
    const greader = gres.body.getReader();
    let greceived = "";
    while (!greceived.includes("event: status")) {
      const { value, done } = await greader.read();
      if (done) break;
      greceived += decoder.decode(value);
    }
    expect(greceived).toContain("subscribed");
    await greader.cancel();
  } finally {
    await sseApp.close();
  }
});

test("deleted schedule fails the job without throwing", async () => {
  const host = await prisma.host.create({
    data: { alias: `test-jobhost-${Date.now()}`, hostname: "192.0.2.34", username: "root" },
  });
  hostId = host.id;
  const schedule = await makeSchedule();
  const jobId = await enqueueUpdateJob(schedule.id, "manual");
  await prisma.updateSchedule.delete({ where: { id: schedule.id } });
  await drainQueue();

  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  expect(job.status).toBe("failed");
});

// --- Reboot rolls (M3.2) ---

async function makeRebootHost(alias: string, bootOrder: number, self = false) {
  return prisma.host.create({
    data: { alias, hostname: "192.0.2.60", username: "root", bootOrder, self },
  });
}

const REBOOT_OK = { ok: true, output: "rebooted", durationMs: 5 };

test("reboot roll runs hosts in bootOrder, each recovering before the next", async () => {
  const a = await makeRebootHost(`test-jobhost-third-${Date.now()}`, 3);
  const b = await makeRebootHost(`test-jobhost-first-${Date.now()}`, 1);
  const c = await makeRebootHost(`test-jobhost-second-${Date.now()}`, 2);
  const order: string[] = [];
  rebootMock.mockImplementation(async (host: { alias: string }) => {
    order.push(host.alias);
    return REBOOT_OK;
  });

  const jobId = await enqueueRebootJob([a.id, b.id, c.id], "manual");
  await drainQueue();

  expect(order).toEqual([b.alias, c.alias, a.alias]); // low bootOrder first
  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    include: { steps: { orderBy: { startedAt: "asc" } } },
  });
  expect(job.kind).toBe("reboot");
  expect(job.status).toBe("succeeded");
  expect(job.steps.map((s) => s.name)).toEqual(["host.reboot", "host.reboot", "host.reboot"]);
});

test("failed recovery aborts the roll; remaining hosts are skipped", async () => {
  const first = await makeRebootHost(`test-jobhost-roll-${Date.now()}`, 1);
  const stuck = await makeRebootHost(`test-jobhost-stuck-${Date.now()}`, 2);
  const last = await makeRebootHost(`test-jobhost-last-${Date.now()}`, 3);
  rebootMock.mockImplementation(async (host: { alias: string }) =>
    host.id === stuck.id
      ? { ok: false, output: "did not recover", durationMs: 5, data: { recovered: false } }
      : REBOOT_OK,
  );

  const jobId = await enqueueRebootJob([first.id, stuck.id, last.id], "manual");
  await drainQueue();

  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    include: { steps: { orderBy: { startedAt: "asc" } } },
  });
  expect(job.status).toBe("failed");
  // first rebooted fine, stuck failed, last never touched
  expect(job.steps.map((s) => [s.hostId, s.ok])).toEqual([
    [first.id, true],
    [stuck.id, false],
  ]);
  expect(rebootMock).toHaveBeenCalledTimes(2);
});

test("update job with rebootAfterUpdate rolls only pending hosts; self host skipped", async () => {
  const plain = await makeRebootHost(`test-jobhost-plain-${Date.now()}`, 1);
  const pending = await makeRebootHost(`test-jobhost-pending-${Date.now()}`, 2);
  const selfHost = await makeRebootHost(`test-jobhost-self-${Date.now()}`, 3, true);
  const schedule = await prisma.updateSchedule.create({
    data: {
      name: `test-job-${Date.now()}`,
      daysOfWeek: [1],
      timeOfDay: "03:00",
      osUpdates: true,
      containerUpdates: false,
      rebootAfterUpdate: true,
      hosts: { connect: [{ id: plain.id }, { id: pending.id }, { id: selfHost.id }] },
    },
  });
  // apt everywhere; reboot-required only on `pending` and `selfHost`
  execMock.mockImplementation(async (h, command: string) => {
    if (command.startsWith("for c in apt-get")) {
      return { ok: true, output: "/usr/bin/apt-get", exitCode: 0, lines: [] };
    }
    if (command.startsWith("if [ -f /var/run/reboot-required")) {
      const pendingExit = h.alias.includes("plain") ? 1 : 0;
      return { ok: pendingExit === 0, output: "", exitCode: pendingExit, lines: [] };
    }
    return { ok: true, output: "ok", exitCode: 0, lines: [] };
  });
  rebootMock.mockResolvedValue(REBOOT_OK);

  await enqueueUpdateJob(schedule.id, "manual");
  await drainQueue();

  const jobs = await prisma.job.findMany({
    where: { schedule: { name: schedule.name } },
    include: { steps: { orderBy: { startedAt: "asc" } }, hosts: true },
    orderBy: { startedAt: "asc" },
  });
  expect(jobs).toHaveLength(2); // update job + reboot roll
  const roll = jobs[1];
  expect(roll.kind).toBe("reboot");
  expect(roll.trigger).toBe("manual");
  expect(roll.status).toBe("succeeded");
  expect(roll.hosts.map((h) => h.id)).toEqual([pending.id]); // plain not pending, self skipped
  expect(roll.steps).toHaveLength(1);

  const skipAudit = await prisma.auditEntry.findFirst({
    where: { action: "host.reboot", target: selfHost.alias },
  });
  expect(skipAudit?.ok).toBe(true);
  expect(skipAudit?.output).toContain("skipped");
});
