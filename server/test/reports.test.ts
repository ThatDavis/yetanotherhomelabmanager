import "./env.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { execOnHost } from "../src/executor.js";
import { drainQueue, enqueueUpdateJob } from "../src/jobs.js";
import { setTransporterForTest } from "../src/notify.js";

vi.mock("../src/executor.js", () => ({ execOnHost: vi.fn() }));
const execMock = vi.mocked(execOnHost);

const PREFIX = "test-report-";
let hostId = "";

// All-positive executor: apt host, os.update succeeds.
function mockAllOk() {
  execMock.mockImplementation(async (_h, command: string) => {
    if (command.startsWith("for c in apt-get"))
      return { ok: true, output: "/usr/bin/apt-get", exitCode: 0, lines: [] };
    return { ok: true, output: "ok", exitCode: 0, lines: [] };
  });
}

// Package-manager detection succeeds, the update itself fails.
function mockUpdateFails() {
  execMock.mockImplementation(async (_h, command: string) => {
    if (command.startsWith("for c in apt-get"))
      return { ok: true, output: "/usr/bin/apt-get", exitCode: 0, lines: [] };
    return { ok: false, output: "E: boom", exitCode: 100, lines: [] };
  });
}

function smtpEnv() {
  process.env.SMTP_HOST = "smtp.test";
  process.env.SMTP_USER = "u@test";
  process.env.SMTP_PASSWORD = "p";
  process.env.SMTP_TO = "op@test";
  process.env.SMTP_FROM = "yahlm@test";
}

async function enableEmail(on: boolean) {
  await prisma.setting.upsert({
    where: { key: "notify.email.enabled" },
    create: { key: "notify.email.enabled", value: String(on) },
    update: { value: String(on) },
  });
}

/** Capture transport: records messages, resolves like nodemailer. */
function captureTransport(messages: { subject: string; text: string }[], failWith?: string) {
  setTransporterForTest({
    sendMail: vi.fn(async (m: { subject: string; text: string }) => {
      if (failWith) throw new Error(failWith);
      messages.push({ subject: m.subject, text: m.text });
      return { messageId: "x" };
    }),
  } as never);
}

async function runOneJob() {
  const schedule = await prisma.updateSchedule.create({
    data: {
      name: `${PREFIX}${Date.now()}`,
      daysOfWeek: [1],
      timeOfDay: "03:00",
      osUpdates: true,
      containerUpdates: false,
      rebootAfterUpdate: false,
      verifyUpdates: false,
      hosts: { connect: { id: hostId } },
    },
  });
  const jobId = await enqueueUpdateJob(schedule.id, "scheduled");
  await drainQueue();
  return jobId;
}

beforeAll(async () => {
  const host = await prisma.host.create({
    data: { alias: `${PREFIX}host`, hostname: "192.0.2.90", username: "root" },
  });
  hostId = host.id;
});

afterEach(async () => {
  execMock.mockReset();
  setTransporterForTest(null);
  vi.restoreAllMocks();
  // undo smtpEnv() — process.env is shared across test files in a worker
  for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_TO", "SMTP_FROM"])
    delete process.env[k];
  await prisma.jobStep.deleteMany({
    where: { job: { schedule: { name: { startsWith: PREFIX } } } },
  });
  await prisma.job.deleteMany({ where: { schedule: { name: { startsWith: PREFIX } } } });
  await prisma.updateSchedule.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.setting.deleteMany({ where: { key: "notify.email.enabled" } });
  await prisma.auditEntry.deleteMany({ where: { action: "notify.report" } });
});

describe("M3.4 email job reports", () => {
  it("emails a report with per-step lines after a completed job", async () => {
    smtpEnv();
    await enableEmail(true);
    mockAllOk();
    const messages: { subject: string; text: string }[] = [];
    captureTransport(messages);
    const jobId = await runOneJob();

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg?.subject).toBe("[YAHLM] update succeeded — 1/1 steps ok");
    expect(msg?.text).toContain(`job ${jobId}`);
    expect(msg?.text).toContain("trigger scheduled");
    expect(msg?.text).toContain(`${PREFIX}host os.update`);
    const audits = await prisma.auditEntry.findMany({ where: { action: "notify.report" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.ok).toBe(true);
  });

  it("does not send when the email channel is disabled", async () => {
    smtpEnv();
    await enableEmail(false);
    mockAllOk();
    const messages: { subject: string; text: string }[] = [];
    captureTransport(messages);
    await runOneJob();

    expect(messages).toHaveLength(0);
    const audits = await prisma.auditEntry.findMany({ where: { action: "notify.report" } });
    expect(audits).toHaveLength(0);
  });

  it("subject reflects failure and failed steps lead the body", async () => {
    smtpEnv();
    await enableEmail(true);
    mockUpdateFails();
    const messages: { subject: string; text: string }[] = [];
    captureTransport(messages);
    const jobId = await runOneJob();

    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("failed");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toContain("update failed — 0/1 steps ok");
    expect(messages[0]?.text).toContain("FAIL");
    expect(messages[0]?.text).toContain("E: boom");
  });

  it("a broken transport audits the failure and never breaks the job", async () => {
    smtpEnv();
    await enableEmail(true);
    mockAllOk();
    captureTransport([], "connection refused");
    const jobId = await runOneJob();

    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
    const audits = await prisma.auditEntry.findMany({ where: { action: "notify.report" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.ok).toBe(false);
    expect(audits[0]?.output).toContain("connection refused");
  });
});
