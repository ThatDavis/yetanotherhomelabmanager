import "./env.js";
import { afterAll, expect, test } from "vitest";
import { buildServer } from "../src/app.js";
import { prisma } from "../src/db.js";
import { storeSecret } from "../src/secrets.js";
import { nodeTest } from "../src/steps.js";

const app = buildServer({ spaDir: "/nonexistent", auth: false });

afterAll(async () => {
  await prisma.pingTarget.deleteMany({ where: { name: "dash-target" } });
  await prisma.node.deleteMany({ where: { name: "dash-node" } });
  await prisma.secret.deleteMany({ where: { id: { startsWith: "node-token-" } } });
  await prisma.auditEntry.deleteMany({ where: { target: { startsWith: "dash-" } } });
  await app.close();
});

test("nodeTest records status on the node row", async () => {
  const node = await prisma.node.create({
    data: { name: "dash-node", type: "pve", url: "https://127.0.0.1:1", tokenId: "a@pam!b" },
  });
  await storeSecret(`node-token-${node.id}`, "fake-token");

  const result = await nodeTest(node); // fails: unreachable
  expect(result.ok).toBe(false);

  const updated = await prisma.node.findUnique({ where: { id: node.id } });
  expect(updated?.status).toBe("down");
  expect(updated?.lastCheckedAt).not.toBeNull();
});

test("dashboard endpoint aggregates summary, nodes, guests, recent audit", async () => {
  await prisma.pingTarget.create({
    data: { name: "dash-target", host: "127.0.0.1", status: "up" },
  });
  await prisma.pingTarget.update({
    where: { name: "dash-target" },
    data: { results: { create: { ok: true, latencyMs: 1 } } },
  });

  const res = await app.inject({ method: "GET", url: "/api/dashboard" });
  expect(res.statusCode).toBe(200);
  const body = res.json();

  expect(body.summary.targetsTotal).toBeGreaterThan(0);
  expect(body.targets.find((t: { name: string }) => t.name === "dash-target").results).toHaveLength(
    1,
  );
  expect(body.nodes.some((n: { name: string }) => n.name === "dash-node")).toBe(true);
  expect(body.guests).toHaveProperty("running");
  expect(Array.isArray(body.recentAudit)).toBe(true);
});
