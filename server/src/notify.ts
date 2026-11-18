import type { Webhook } from "@prisma/client";
import nodemailer, { type Transporter } from "nodemailer";
import { audit } from "./audit.js";
import { prisma } from "./db.js";

// Notification sender for state transitions (M2.3). Two channels:
// email via env-configured SMTP relay, and DB-backed webhooks (POST JSON).
// Sending must never throw into the check loop — every failure is audited
// as notify.fail and swallowed. Callers await this only for ordering.

export type Alert = {
  source: "target" | "node"; // what transitioned
  name: string;
  from: string; // previous status
  to: string; // new status
  detail: string; // human-readable context, e.g. "3/3 failures: timeout"
};

type EmailConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
};

// Read fresh each call: settings can change without a restart.
export async function emailEnabled(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: "notify.email.enabled" } });
  return row?.value === "true";
}

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}

function emailConfig(): EmailConfig {
  return {
    host: process.env.SMTP_HOST ?? "",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASSWORD ?? "",
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "yahlm@localhost",
    to: process.env.SMTP_TO ?? process.env.SMTP_USER ?? "",
  };
}

let transporter: Transporter | null = null;
// Test seam: inject a fake transport (e.g. nodemailer's jsonTransport); null restores env-based.
export function setTransporterForTest(t: Transporter | null): void {
  transporter = t;
}
function getTransporter(): Transporter {
  // Reuse across sends; env does not change at runtime.
  transporter ??= nodemailer.createTransport({
    host: emailConfig().host,
    port: emailConfig().port,
    secure: emailConfig().secure,
    auth: { user: emailConfig().user, pass: emailConfig().pass },
  });
  return transporter;
}

const alertSubject = (a: Alert) =>
  `[YAHLM] ${a.name} ${a.to === "down" ? "DOWN" : "recovered"} (${a.source})`;

const alertText = (a: Alert) =>
  `${a.source} "${a.name}" changed state: ${a.from} → ${a.to}\n${a.detail}\n`;

async function sendEmail(alert: Alert): Promise<void> {
  await getTransporter().sendMail({
    from: emailConfig().from,
    to: emailConfig().to,
    subject: alertSubject(alert),
    text: alertText(alert),
  });
}

async function postWebhook(webhook: Webhook, alert: Alert): Promise<void> {
  const res = await fetch(webhook.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: alert.to === "down" ? "state.down" : "state.up",
      source: alert.source,
      name: alert.name,
      from: alert.from,
      to: alert.to,
      detail: alert.detail,
      at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export type ChannelResult = { channel: string; ok: boolean; error?: string };

async function deliver(
  channel: string,
  alert: Alert,
  fn: () => Promise<void>,
): Promise<ChannelResult> {
  try {
    await fn();
    await audit({
      action: "notify.send",
      target: alert.name,
      params: { channel },
      ok: true,
      output: `${alert.from} → ${alert.to}`,
    });
    return { channel, ok: true };
  } catch (err) {
    const message = (err as Error).message;
    await audit({
      action: "notify.fail",
      target: alert.name,
      params: { channel },
      ok: false,
      output: message,
    });
    return { channel, ok: false, error: message };
  }
}

// Send a transition alert to the given channels. Never throws; one result per attempted channel.
export async function sendAlert(
  alert: Alert,
  channels: { email: boolean; webhooks: Webhook[] },
): Promise<ChannelResult[]> {
  const jobs: Promise<ChannelResult>[] = [];
  if (channels.email && smtpConfigured())
    jobs.push(deliver("email", alert, () => sendEmail(alert)));
  for (const webhook of channels.webhooks) {
    if (webhook.enabled)
      jobs.push(
        deliver(`webhook:${webhook.name || webhook.url}`, alert, () => postWebhook(webhook, alert)),
      );
  }
  return Promise.all(jobs);
}

// Channel resolution for node transitions: every enabled channel.
export async function allChannels(): Promise<{ email: boolean; webhooks: Webhook[] }> {
  return {
    email: smtpConfigured() && (await emailEnabled()),
    webhooks: await prisma.webhook.findMany({ where: { enabled: true } }),
  };
}

// M3.4: email report after any completed job (scheduled or manual) when the
// email channel is enabled — the "did the nightly update work" heartbeat.
// Reports never affect the job result: failures are audited, not thrown.
export async function sendJobReport(jobId: string): Promise<void> {
  if (!(await emailEnabled()) || !smtpConfigured()) return;
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      steps: { include: { host: { select: { alias: true } } }, orderBy: { id: "asc" } },
      schedule: { select: { name: true } },
    },
  });
  if (!job || job.status === "running") return;
  const total = job.steps.length;
  const okCount = job.steps.filter((s) => s.ok).length;
  const fmt = (s: (typeof job.steps)[number]) => {
    const head =
      `${s.ok ? "ok  " : "FAIL"} ${s.host?.alias ?? "-"} ${s.name}` +
      `${s.phase ? ` (${s.phase})` : ""} ${(s.durationMs / 1000).toFixed(1)}s`;
    if (s.ok) return head;
    const tail = s.output.split("\n").slice(-5).join("\n    ");
    return tail ? `${head}\n    ${tail}` : head;
  };
  const failures = job.steps.filter((s) => !s.ok);
  const body = [
    `job ${job.id} — ${job.kind}${job.project ? ` (${job.project})` : ""}, trigger ${job.trigger}` +
      `${job.schedule ? `, schedule "${job.schedule.name}"` : ""}`,
    `started ${job.startedAt.toISOString()}, finished ${job.finishedAt?.toISOString() ?? "-"}`,
    `${okCount}/${total} steps ok`,
    "",
    ...failures.map(fmt),
    ...(failures.length ? [""] : []),
    ...job.steps.filter((s) => s.ok).map(fmt),
  ].join("\n");
  try {
    await getTransporter().sendMail({
      from: emailConfig().from,
      to: emailConfig().to,
      subject: `[YAHLM] ${job.kind} ${job.status} — ${okCount}/${total} steps ok`,
      text: body,
    });
    await audit({
      action: "notify.report",
      target: job.id,
      ok: true,
      output: `${job.kind} ${job.status}, ${okCount}/${total} steps ok`,
    });
  } catch (err) {
    await audit({
      action: "notify.report",
      target: job.id,
      ok: false,
      output: (err as Error).message,
    });
  }
}
