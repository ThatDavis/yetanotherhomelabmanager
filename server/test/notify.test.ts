import "./env.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildServer } from "../src/app.js";
import { prisma } from "../src/db.js";
import { type Alert, sendAlert, setTransporterForTest } from "../src/notify.js";
import { nodeTest, pingCheck } from "../src/steps.js";

const PREFIX = "notifytest-";
const app = buildServer({ spaDir: "/nonexistent", auth: false });

// Local capture server standing in for webhook endpoints.
let capture: http.Server;
const captured: { body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  capture = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.push({ body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => capture.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  await prisma.webhook.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.pingTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.node.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.auditEntry.deleteMany({ where: { target: { startsWith: PREFIX } } });
  await prisma.setting.deleteMany({ where: { key: "notify.email.enabled" } });
  setTransporterForTest(null);
  await new Promise((resolve) => capture.close(resolve));
  await app.close();
});

function hookUrl(): string {
  return `http://127.0.0.1:${(capture.address() as AddressInfo).port}/hook`;
}

async function makeWebhook(name: string, enabled = true) {
  return prisma.webhook.create({ data: { name: `${PREFIX}${name}`, url: hookUrl(), enabled } });
}

const alert: Alert = {
  source: "target",
  name: `${PREFIX}unit`,
  from: "up",
  to: "down",
  detail: "3/3 failures: timeout",
};

test("sendAlert posts JSON to webhook and audits notify.send", async () => {
  captured.length = 0;
  const webhook = await makeWebhook("unit");
  const results = await sendAlert(alert, { email: false, webhooks: [webhook] });
  expect(results).toEqual([{ channel: `webhook:${webhook.name}`, ok: true }]);
  expect(captured).toHaveLength(1);
  expect(captured[0].body).toMatchObject({
    event: "state.down",
    source: "target",
    name: alert.name,
    from: "up",
    to: "down",
  });
  const sent = await prisma.auditEntry.findFirst({
    where: { action: "notify.send", target: alert.name },
  });
  expect(sent?.ok).toBe(true);
});

test("sendAlert failure returns ok:false, audits notify.fail, never throws", async () => {
  const webhook = await prisma.webhook.create({
    data: { name: `${PREFIX}dead`, url: "http://127.0.0.1:1/hook", enabled: true },
  });
  const results = await sendAlert(alert, { email: false, webhooks: [webhook] });
  expect(results[0].ok).toBe(false);
  expect(results[0].error).toBeTruthy();
  const failed = await prisma.auditEntry.findFirst({
    where: { action: "notify.fail", target: alert.name },
  });
  expect(failed?.ok).toBe(false);
});

test("no enabled channels → zero sends, empty results", async () => {
  captured.length = 0;
  const disabled = await makeWebhook("off", false);
  const results = await sendAlert(alert, { email: false, webhooks: [disabled] });
  expect(results).toEqual([]);
  expect(captured).toHaveLength(0);
});

test("email channel sends via SMTP transport", async () => {
  const saved = { ...process.env };
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_USER = "yahlm@example.test";
  process.env.SMTP_PASSWORD = "secret";
  const jsonTransport = nodemailer.createTransport({ jsonTransport: true });
  setTransporterForTest(jsonTransport);
  try {
    const results = await sendAlert(alert, { email: true, webhooks: [] });
    expect(results).toEqual([{ channel: "email", ok: true }]);
    const sent = await prisma.auditEntry.findFirst({
      where: { action: "notify.send", target: alert.name, params: { contains: "email" } },
    });
    expect(sent?.ok).toBe(true);
  } finally {
    setTransporterForTest(null);
    process.env = { ...saved };
  }
});

test("pingCheck notifies selected webhook on down and recovery", async () => {
  captured.length = 0;
  const webhook = await makeWebhook("ping");
  const target = await prisma.pingTarget.create({
    data: {
      name: `${PREFIX}ping`,
      host: "192.0.2.1", // unroutable — fails
      alertAfter: 1,
      status: "up", // known-up so unknown→down guard doesn't apply
      notify: true,
      webhooks: { connect: [{ id: webhook.id }] },
    },
  });

  const down = await pingCheck(target);
  expect(down.ok).toBe(false);
  expect(captured).toHaveLength(1);
  expect(captured[0].body).toMatchObject({ event: "state.down", name: target.name });

  await prisma.pingTarget.update({ where: { id: target.id }, data: { host: "127.0.0.1" } });
  const recovered = await pingCheck(
    await prisma.pingTarget.findUniqueOrThrow({ where: { id: target.id } }),
  );
  expect(recovered.ok).toBe(true);
  expect(captured).toHaveLength(2);
  expect(captured[1].body).toMatchObject({ event: "state.up", name: target.name });
});

test("pingCheck: notify=false or unknown→down sends nothing", async () => {
  captured.length = 0;
  const quiet = await prisma.pingTarget.create({
    data: { name: `${PREFIX}quiet`, host: "192.0.2.1", alertAfter: 1, status: "up" },
  });
  await pingCheck(quiet);

  const fresh = await prisma.pingTarget.create({
    data: {
      name: `${PREFIX}fresh`,
      host: "192.0.2.1",
      alertAfter: 1,
      notify: true,
      webhooks: { connect: [{ id: (await makeWebhook("fresh")).id }] },
    },
  });
  await pingCheck(fresh);

  expect(captured).toHaveLength(0);
  // The unknown→down transition is still audited, just not alerted.
  const transition = await prisma.auditEntry.findFirst({
    where: { action: "ping.transition", target: fresh.name },
  });
  expect(transition?.output).toBe("unknown → down");
});

test("nodeTest transition notifies all enabled channels exactly once per flip", async () => {
  captured.length = 0;
  await makeWebhook("node");
  const node = await prisma.node.create({
    data: {
      name: `${PREFIX}node`,
      type: "pve",
      url: "https://127.0.0.1:1", // unreachable, but no secret short-circuits first
      tokenId: "test@pve!x",
      status: "up",
    },
  });

  const first = await nodeTest(node);
  expect(first.ok).toBe(false); // no API token secret stored
  // Node alerts go to EVERY enabled webhook — count them rather than assume one.
  const enabled = await prisma.webhook.count({ where: { enabled: true, url: hookUrl() } });
  expect(captured).toHaveLength(enabled);
  for (const post of captured) {
    expect(post.body).toMatchObject({ event: "state.down", source: "node", name: node.name });
  }

  // Still down → no duplicate alert.
  const again = await nodeTest(await prisma.node.findUniqueOrThrow({ where: { id: node.id } }));
  expect(again.ok).toBe(false);
  expect(captured).toHaveLength(enabled);
});

test("alerts API: email toggle, webhook CRUD, test-send", async () => {
  captured.length = 0;

  const put = await app.inject({
    method: "PUT",
    url: "/api/alerts/email",
    payload: { enabled: true },
  });
  expect(put.statusCode).toBe(200);
  const config = await app.inject({ method: "GET", url: "/api/alerts" });
  expect(config.json()).toMatchObject({ emailEnabled: true, smtpConfigured: false });

  const bad = await app.inject({
    method: "POST",
    url: "/api/webhooks",
    payload: { url: "not-a-url" },
  });
  expect(bad.statusCode).toBe(400);

  const created = await app.inject({
    method: "POST",
    url: "/api/webhooks",
    payload: { name: `${PREFIX}api`, url: hookUrl() },
  });
  expect(created.statusCode).toBe(201);
  const webhook = created.json() as { id: string; enabled: boolean };
  expect(webhook.enabled).toBe(true);

  const patched = await app.inject({
    method: "PATCH",
    url: `/api/webhooks/${webhook.id}`,
    payload: { enabled: false },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json()).toMatchObject({ enabled: false });

  const test = await app.inject({ method: "POST", url: `/api/webhooks/${webhook.id}/test` });
  expect(test.statusCode).toBe(200);
  expect(test.json().results[0].ok).toBe(true);
  expect(captured.at(-1)?.body).toMatchObject({ name: "test" });

  const missing = await app.inject({ method: "DELETE", url: "/api/webhooks/nope" });
  expect(missing.statusCode).toBe(404);

  const removed = await app.inject({ method: "DELETE", url: `/api/webhooks/${webhook.id}` });
  expect(removed.statusCode).toBe(200);
});
