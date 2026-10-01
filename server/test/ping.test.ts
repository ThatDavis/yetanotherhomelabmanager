import "./env.js";
import { afterAll, expect, test } from "vitest";
import { buildServer } from "../src/app.js";
import { prisma } from "../src/db.js";
import { ping } from "../src/ping.js";
import { pingCheck } from "../src/steps.js";

const app = buildServer({ spaDir: "/nonexistent", auth: false });

async function makeTarget(alertAfter = 3): Promise<string> {
  const target = await prisma.pingTarget.create({
    data: { name: `pingtest-${Date.now()}`, host: "127.0.0.1", alertAfter },
  });
  return target.id;
}

afterAll(async () => {
  await prisma.pingTarget.deleteMany({ where: { name: { startsWith: "pingtest-" } } });
  await prisma.auditEntry.deleteMany({ where: { target: { startsWith: "pingtest-" } } });
  await app.close();
});

test("ping localhost succeeds with latency; bad host fails", async () => {
  const good = await ping("127.0.0.1");
  expect(good.ok).toBe(true);
  expect(good.latencyMs).not.toBeNull();

  const bad = await ping("192.0.2.1", 1); // TEST-NET-1, unroutable
  expect(bad.ok).toBe(false);
  expect(bad.error).toBeTruthy();
});

test("state machine: down after alertAfter failures, up on first success", async () => {
  const id = await makeTarget(2);
  // Force failures with an unroutable host
  await prisma.pingTarget.update({ where: { id }, data: { host: "192.0.2.1" } });

  let target = (await prisma.pingTarget.findUnique({ where: { id } }))!;
  const first = await pingCheck(target);
  expect(first.ok).toBe(false);
  target = (await prisma.pingTarget.findUnique({ where: { id } }))!;
  expect(target.status).toBe("unknown"); // 1/2 failures — not yet down
  expect(target.consecutiveFailures).toBe(1);

  await pingCheck(target);
  target = (await prisma.pingTarget.findUnique({ where: { id } }))!;
  expect(target.status).toBe("down"); // 2/2 — threshold crossed

  // Transition recorded
  const transitions = await prisma.auditEntry.findMany({
    where: { action: "ping.transition", target: target.name },
  });
  expect(transitions.map((t) => t.output)).toContain("unknown → down");

  // Success flips back up immediately
  await prisma.pingTarget.update({ where: { id }, data: { host: "127.0.0.1" } });
  target = (await prisma.pingTarget.findUnique({ where: { id } }))!;
  const recovered = await pingCheck(target);
  expect(recovered.ok).toBe(true);
  target = (await prisma.pingTarget.findUnique({ where: { id } }))!;
  expect(target.status).toBe("up");
  expect(target.consecutiveFailures).toBe(0);
});

test("results are persisted per check", async () => {
  const id = await makeTarget();
  const target = (await prisma.pingTarget.findUnique({ where: { id } }))!;
  await pingCheck(target);
  await pingCheck(target);
  const results = await prisma.checkResult.findMany({ where: { targetId: id } });
  expect(results).toHaveLength(2);
  expect(results.every((r) => r.ok)).toBe(true);
});

test("targets CRUD via API, audited", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/targets",
    payload: { name: "pingtest-crud", host: "127.0.0.1", intervalSec: 30, alertAfter: 5 },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id;

  const list = await app.inject({ method: "GET", url: "/api/targets" });
  expect(list.json().map((t: { name: string }) => t.name)).toContain("pingtest-crud");

  const patched = await app.inject({
    method: "PATCH",
    url: `/api/targets/${id}`,
    payload: { alertAfter: 7 },
  });
  expect(patched.json().alertAfter).toBe(7);

  const checked = await app.inject({ method: "POST", url: `/api/targets/${id}/check` });
  expect(checked.json().ok).toBe(true);

  const removed = await app.inject({ method: "DELETE", url: `/api/targets/${id}` });
  expect(removed.statusCode).toBe(200);

  const audits = await prisma.auditEntry.findMany({
    where: { target: "pingtest-crud", action: { startsWith: "target." } },
  });
  expect(audits.map((a) => a.action)).toEqual([
    "target.register",
    "target.update",
    "target.remove",
  ]);
});
