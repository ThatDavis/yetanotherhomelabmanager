import "./env.js";
import { afterEach, expect, test, vi } from "vitest";
import { buildServer } from "../src/app.js";
import { prisma } from "../src/db.js";
import { execOnHost } from "../src/executor.js";
import { drainQueue } from "../src/jobs.js";
import { checkUpdateSchedules } from "../src/scheduler.js";

vi.mock("../src/executor.js", () => ({
  execOnHost: vi.fn(),
}));

const execMock = vi.mocked(execOnHost);
const app = buildServer({ spaDir: "/nonexistent", auth: false });

async function makeHost(alias: string) {
  return prisma.host.create({
    data: { alias, hostname: "192.0.2.40", username: "root" },
  });
}

afterEach(async () => {
  execMock.mockReset();
  await prisma.jobStep.deleteMany({
    where: { job: { schedule: { name: { startsWith: "test-sched-" } } } },
  });
  await prisma.job.deleteMany({ where: { schedule: { name: { startsWith: "test-sched-" } } } });
  await prisma.job.deleteMany({ where: { scheduleId: null } });
  await prisma.updateSchedule.deleteMany({ where: { name: { startsWith: "test-sched-" } } });
  await prisma.host.deleteMany({ where: { alias: { startsWith: "test-schedhost-" } } });
  await prisma.auditEntry.deleteMany({ where: { target: { startsWith: "test-sched" } } });
});

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

test("schedule CRUD with host scoping and audit trail", async () => {
  const host = await makeHost(`test-schedhost-${Date.now()}`);
  const payload = {
    name: "test-sched-weekly",
    daysOfWeek: [0, 3],
    timeOfDay: "03:30",
    osUpdates: true,
    containerUpdates: true,
    hostIds: [host.id],
  };
  const created = await app.inject({ method: "POST", url: "/api/schedules", payload });
  expect(created.statusCode).toBe(201);
  expect(created.json().hosts[0].id).toBe(host.id);

  const dup = await app.inject({ method: "POST", url: "/api/schedules", payload });
  expect(dup.statusCode).toBe(409);

  const id = created.json().id;
  const patched = await app.inject({
    method: "PATCH",
    url: `/api/schedules/${id}`,
    payload: { enabled: false },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().enabled).toBe(false);
  expect(patched.json().containerUpdates).toBe(true); // omitted fields untouched

  const removed = await app.inject({ method: "DELETE", url: `/api/schedules/${id}` });
  expect(removed.statusCode).toBe(200);

  const actions = await prisma.auditEntry.findMany({
    where: { action: { startsWith: "schedule." } },
    orderBy: { at: "asc" },
  });
  expect(actions.map((a) => a.action)).toEqual([
    "schedule.create",
    "schedule.create", // duplicate attempt, audited as failure
    "schedule.update",
    "schedule.remove",
  ]);
});

test("invalid schedule payloads return 400", async () => {
  const badTime = await app.inject({
    method: "POST",
    url: "/api/schedules",
    payload: { name: "test-sched-badtime", daysOfWeek: [1], timeOfDay: "25:00" },
  });
  expect(badTime.statusCode).toBe(400);

  const badDay = await app.inject({
    method: "POST",
    url: "/api/schedules",
    payload: { name: "test-sched-badday", daysOfWeek: [7], timeOfDay: "03:00" },
  });
  expect(badDay.statusCode).toBe(400);

  const rows = await prisma.auditEntry.findMany({ where: { action: "schedule.create" } });
  expect(rows).toHaveLength(0);
});

test("run-now enqueues a job and returns 202", async () => {
  const host = await makeHost(`test-schedhost-${Date.now()}`);
  const created = await app.inject({
    method: "POST",
    url: "/api/schedules",
    payload: { name: "test-sched-run", daysOfWeek: [1], timeOfDay: "03:00", hostIds: [host.id] },
  });
  const id = created.json().id;

  execMock.mockImplementation(async (_h, command: string) => {
    if (command.startsWith("for c in apt-get")) {
      return { ok: true, output: "/usr/bin/apt-get", exitCode: 0, lines: [] };
    }
    return { ok: true, output: "ok", exitCode: 0, lines: [] };
  });
  const run = await app.inject({ method: "POST", url: `/api/schedules/${id}/run` });
  expect(run.statusCode).toBe(202);
  await drainQueue();

  const job = await prisma.job.findUniqueOrThrow({
    where: { id: run.json().jobId },
    include: { steps: true },
  });
  expect(job.trigger).toBe("manual");
  expect(job.status).toBe("succeeded");

  const audited = await prisma.auditEntry.findFirst({ where: { action: "schedule.run" } });
  expect(audited?.ok).toBe(true);

  const missing = await app.inject({ method: "POST", url: "/api/schedules/nope/run" });
  expect(missing.statusCode).toBe(404);
});

test("scheduler fires due schedules once per day", async () => {
  const host = await makeHost(`test-schedhost-${Date.now()}`);
  const now = new Date();
  await prisma.updateSchedule.create({
    data: {
      name: "test-sched-due",
      daysOfWeek: [now.getDay()],
      timeOfDay: nowHHMM(),
      enabled: true,
      hosts: { connect: { id: host.id } },
    },
  });
  // Not due: different day.
  await prisma.updateSchedule.create({
    data: {
      name: "test-sched-notdue",
      daysOfWeek: [(now.getDay() + 1) % 7],
      timeOfDay: nowHHMM(),
      enabled: true,
      hosts: { connect: { id: host.id } },
    },
  });

  execMock.mockImplementation(async (_h, command: string) => {
    if (command.startsWith("for c in apt-get")) {
      return { ok: true, output: "/usr/bin/apt-get", exitCode: 0, lines: [] };
    }
    return { ok: true, output: "ok", exitCode: 0, lines: [] };
  });

  await checkUpdateSchedules();
  await drainQueue();
  const fired = await prisma.job.findMany({
    where: { schedule: { name: { startsWith: "test-sched-" } } },
    include: { schedule: true },
  });
  expect(fired).toHaveLength(1);
  expect(fired[0].trigger).toBe("scheduled");
  expect(fired[0].status).toBe("succeeded");
  expect(fired[0].schedule?.name).toBe("test-sched-due");

  // Second tick the same minute: already stamped, must not double-fire.
  await checkUpdateSchedules();
  expect(
    await prisma.job.count({ where: { schedule: { name: { startsWith: "test-sched-" } } } }),
  ).toBe(1);
});
