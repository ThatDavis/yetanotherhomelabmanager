import "./env.js";
import { afterEach, expect, test } from "vitest";
import { buildServer } from "../src/app.js";
import { prisma } from "../src/db.js";

const app = buildServer({ spaDir: "/nonexistent", auth: false });

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

test("reboot on missing host returns 404", async () => {
  const res = await app.inject({ method: "POST", url: "/api/hosts/nope/reboot" });
  expect(res.statusCode).toBe(404);
});

test("host PATCH wholesale-replaces declared services", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/hosts",
    payload: { ...host, alias: "test-svc-host" },
  });
  const id = created.json().id;

  const set = await app.inject({
    method: "PATCH",
    url: `/api/hosts/${id}`,
    payload: {
      services: [
        { name: "web", port: 8080 },
        { name: "db", port: 5432 },
      ],
    },
  });
  expect(set.statusCode).toBe(200);

  const list = await app.inject({ method: "GET", url: "/api/hosts" });
  const found = list.json().find((h: { id: string }) => h.id === id);
  expect(found.services.map((s: { name: string; port: number }) => [s.name, s.port])).toEqual([
    ["db", 5432],
    ["web", 8080],
  ]);

  // Replace again: previous entries are gone, not merged.
  await app.inject({
    method: "PATCH",
    url: `/api/hosts/${id}`,
    payload: { services: [{ name: "ssh", port: 22 }] },
  });
  const after = await app.inject({ method: "GET", url: "/api/hosts" });
  const found2 = after.json().find((h: { id: string }) => h.id === id);
  expect(found2.services.map((s: { name: string }) => s.name)).toEqual(["ssh"]);

  const bad = await app.inject({
    method: "PATCH",
    url: `/api/hosts/${id}`,
    payload: { services: [{ name: "x", port: 70000 }] },
  });
  expect(bad.statusCode).toBe(400);

  await prisma.host.delete({ where: { id } });
});

test("reboot of the self host is refused and audited", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/hosts",
    payload: { ...host, alias: "test-self-host", self: true },
  });
  const id = created.json().id;
  const res = await app.inject({ method: "POST", url: `/api/hosts/${id}/reboot` });
  expect(res.statusCode).toBe(409);

  const row = await prisma.auditEntry.findFirst({
    where: { action: "host.reboot", target: "test-self-host" },
  });
  expect(row?.ok).toBe(false);
  expect(row?.output).toContain("refused");
  await prisma.host.delete({ where: { id } });
});
