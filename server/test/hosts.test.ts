import "./env.js";
import { afterEach, expect, test } from "vitest";
import { buildServer } from "../src/app.js";
import { prisma } from "../src/db.js";

const app = buildServer({ spaDir: "/nonexistent" });

const host = {
  alias: "test-host",
  hostname: "192.0.2.10",
  port: 22,
  username: "root",
  notes: "test",
};
afterEach(async () => {
  await prisma.host.deleteMany({ where: { alias: { startsWith: "test-" } } });
  await prisma.auditEntry.deleteMany({ where: { target: { startsWith: "test-" } } });
});

test("host CRUD writes audit entries", async () => {
  const created = await app.inject({ method: "POST", url: "/api/hosts", payload: host });
  expect(created.statusCode).toBe(201);
  const id = created.json().id;

  const list = await app.inject({ method: "GET", url: "/api/hosts" });
  expect(list.json().map((h: { alias: string }) => h.alias)).toContain("test-host");

  const dup = await app.inject({ method: "POST", url: "/api/hosts", payload: host });
  expect(dup.statusCode).toBe(409);

  const removed = await app.inject({ method: "DELETE", url: `/api/hosts/${id}` });
  expect(removed.statusCode).toBe(200);

  const auditRows = await prisma.auditEntry.findMany({
    where: { action: { in: ["host.register", "host.remove"] }, target: "test-host" },
    orderBy: { at: "asc" },
  });
  // register ok, register duplicate fail, remove ok
  expect(auditRows.map((r) => r.ok)).toEqual([true, false, true]);
});

test("invalid host payload returns 400 and no audit row", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/hosts",
    payload: { ...host, alias: "INVALID ALIAS" },
  });
  expect(res.statusCode).toBe(400);
  const rows = await prisma.auditEntry.findMany({
    where: { action: "host.register", target: "INVALID ALIAS" },
  });
  expect(rows).toHaveLength(0);
});

test("bootstrap endpoint serves a script containing the master public key", async () => {
  const created = await app.inject({ method: "POST", url: "/api/hosts", payload: host });
  const id = created.json().id;

  const key = await app.inject({ method: "GET", url: "/api/master-key" });
  expect(key.json().publicKey).toMatch(/^ssh-ed25519 /);

  const script = await app.inject({ method: "GET", url: `/api/hosts/${id}/bootstrap` });
  expect(script.statusCode).toBe(200);
  expect(script.body).toContain(key.json().publicKey);
});

test("probe on missing host returns 404", async () => {
  const res = await app.inject({ method: "POST", url: "/api/hosts/nope/probe" });
  expect(res.statusCode).toBe(404);
});
