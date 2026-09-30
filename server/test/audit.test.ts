import "./env.js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildServer } from "../src/app.js";
import { prisma } from "../src/db.js";

const app = buildServer({ spaDir: "/nonexistent", auth: false });

async function seed() {
  const base = Date.now();
  const rows = [
    { action: "node.sync", target: "auditseed-main", ok: true, at: new Date(base - 1000) },
    {
      action: "node.sync",
      target: "auditseed-offsite",
      ok: false,
      output: "connection failed",
      at: new Date(base - 2000),
    },
    { action: "node.test", target: "auditseed-main", ok: true, at: new Date(base - 3000) },
    { action: "host.register", target: "auditseed-host", ok: true, at: new Date(base - 4000) },
    {
      action: "auth.login",
      target: "auditseed-key",
      ok: false,
      output: "rejected",
      at: new Date(base - 5000),
    },
  ];
  for (const r of rows) {
    await prisma.auditEntry.create({ data: { actor: "test", ...r } });
  }
}

beforeAll(seed);

afterAll(async () => {
  await prisma.auditEntry.deleteMany({ where: { actor: "test" } });
  await app.close();
});

test("filters by action prefix", async () => {
  const res = await app.inject({ method: "GET", url: "/api/audit?action=node.&target=auditseed" });
  const actions = res.json().entries.map((e: { action: string }) => e.action);
  expect(actions).toEqual(["node.sync", "node.sync", "node.test"]);
});

test("filters failures only", async () => {
  const res = await app.inject({ method: "GET", url: "/api/audit?ok=false&target=auditseed" });
  const oks = res.json().entries.map((e: { ok: boolean }) => e.ok);
  expect(oks).toEqual([false, false]);
});

test("filters by target substring", async () => {
  const res = await app.inject({ method: "GET", url: "/api/audit?target=auditseed-offsite" });
  expect(res.json().entries).toHaveLength(1);
  expect(res.json().entries[0].target).toBe("auditseed-offsite");
});

test("paginates with the before cursor", async () => {
  const first = await app.inject({
    method: "GET",
    url: "/api/audit?action=node.&target=auditseed&limit=2",
  });
  expect(first.json().entries).toHaveLength(2);
  expect(first.json().nextBefore).toBeTruthy();

  const second = await app.inject({
    method: "GET",
    url: `/api/audit?action=node.&target=auditseed&limit=2&before=${encodeURIComponent(first.json().nextBefore)}`,
  });
  expect(second.json().entries).toHaveLength(1);
  expect(second.json().entries[0].action).toBe("node.test");
  expect(second.json().nextBefore).toBeNull();
});
