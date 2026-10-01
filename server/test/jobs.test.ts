import "./env.js";
import { afterEach, expect, test, vi } from "vitest";
import { buildServer } from "../src/app.js";
import { prisma } from "../src/db.js";
import { execOnHost } from "../src/executor.js";
import { drainQueue, enqueueUpdateJob } from "../src/jobs.js";

vi.mock("../src/executor.js", () => ({
  execOnHost: vi.fn(),
}));

const execMock = vi.mocked(execOnHost);
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
