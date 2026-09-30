import "./env.js";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildServer } from "../src/app.js";
import { prisma } from "../src/db.js";

// Mock PVE/PBS API for inventory sync. Second "node" is a dead port to prove
// per-node failure isolation in POST /api/sync.

const MOCK_PORT = 18444;
const DEAD_PORT = 18445;
const tmp = mkdtempSync(path.join(os.tmpdir(), "yahlm-inv-mock-"));
const app = buildServer({ spaDir: "/nonexistent" });

let mock: https.Server;
let guestList: unknown[] = [
  { vmid: 100, name: "web-1", status: "running", type: "qemu", node: "pve-1" },
  { vmid: 101, name: "db-1", status: "stopped", type: "lxc", node: "pve-1" },
];

function cert(): { key: string; cert: string } {
  const keyPath = path.join(tmp, "k.pem");
  const certPath = path.join(tmp, "c.pem");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyPath} -out ${certPath} -days 1 -subj /CN=inv`,
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
}

beforeAll(async () => {
  mock = https.createServer(cert(), (req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url ?? "/", "https://mock");
    const type = url.searchParams.get("type");
    if (url.pathname === "/api2/json/cluster/resources" && type === "vm") {
      res.writeHead(200).end(JSON.stringify({ data: guestList }));
      return;
    }
    if (url.pathname === "/api2/json/cluster/resources" && type === "storage") {
      res.writeHead(200).end(JSON.stringify({ data: [{ storage: "local" }, { storage: "nfs" }] }));
      return;
    }
    if (url.pathname === "/api2/json/cluster/backup") {
      res
        .writeHead(200)
        .end(JSON.stringify({ data: [{ id: "job-1", enabled: 1, schedule: "daily" }] }));
      return;
    }
    if (url.pathname === "/api2/json/admin/datastore") {
      res.writeHead(200).end(JSON.stringify({ data: [{ store: "backups" }] }));
      return;
    }
    if (url.pathname === "/api2/json/admin/datastore/backups/snapshots") {
      res.writeHead(200).end(
        JSON.stringify({
          data: [
            { "backup-time": 1000, "backup-id": "vm-100-a" },
            { "backup-time": 3000, "backup-id": "vm-100-b" },
            { "backup-time": 2000, "backup-id": "vm-101-a" },
          ],
        }),
      );
      return;
    }
    res.writeHead(404).end("{}");
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  mock.listen(MOCK_PORT, "127.0.0.1", resolve);
  await promise;
});

afterAll(async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  mock.close(() => resolve());
  await promise;
  await prisma.guest.deleteMany({});
  await prisma.node.deleteMany({ where: { name: { startsWith: "inv-" } } });
  await prisma.secret.deleteMany({ where: { id: { startsWith: "node-token-" } } });
  await prisma.auditEntry.deleteMany({ where: { target: { startsWith: "inv-" } } });
  await app.close();
});

async function register(name: string, type: "pve" | "pbs", port: number): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/nodes",
    payload: {
      name,
      type,
      url: `https://127.0.0.1:${port}`,
      tokenId: "yahlm@pam!api",
      tokenSecret: "s",
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

test("PVE sync persists guests with storage and job summary", async () => {
  const id = await register("inv-pve", "pve", MOCK_PORT);
  const res = await app.inject({ method: "POST", url: `/api/nodes/${id}/sync` });
  expect(res.json().ok).toBe(true);
  expect(res.json().output).toContain("synced 2 guests (1 running)");
  expect(res.json().output).toContain("2 storage pools");
  expect(res.json().output).toContain("1 backup jobs (1 enabled)");

  const guests = await app.inject({ method: "GET", url: "/api/guests" });
  const rows = guests.json();
  expect(rows).toHaveLength(2);
  expect(rows.find((g: { name: string }) => g.name === "web-1")).toMatchObject({
    vmid: 100,
    type: "qemu",
    status: "running",
    nodeName: "inv-pve",
  });
});

test("re-sync prunes guests the node no longer reports", async () => {
  const id = await register("inv-pve-2", "pve", MOCK_PORT);
  await app.inject({ method: "POST", url: `/api/nodes/${id}/sync` });
  guestList = [{ vmid: 100, name: "web-1", status: "running", type: "qemu", node: "pve-1" }];
  const res = await app.inject({ method: "POST", url: `/api/nodes/${id}/sync` });
  expect(res.json().output).toContain("pruned 1 stale");

  const rows = await prisma.guest.findMany({ where: { nodeDbId: id } });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.vmid).toBe(100);
});

test("sync-all isolates per-node failures", async () => {
  const goodId = await register("inv-good", "pve", MOCK_PORT);
  await register("inv-dead", "pve", DEAD_PORT);

  const res = await app.inject({ method: "POST", url: "/api/sync" });
  const body = res.json();
  expect(body.ok).toBe(false);

  const good = body.results.find((r: { node: string }) => r.node === "inv-good");
  const dead = body.results.find((r: { node: string }) => r.node === "inv-dead");
  expect(good.ok).toBe(true);
  expect(dead.ok).toBe(false);
  expect(dead.output).toContain("connection failed");

  // Failed node did not blank the good node's inventory
  const guests = await prisma.guest.findMany({ where: { nodeDbId: goodId } });
  expect(guests.length).toBeGreaterThan(0);
});

test("PBS sync summarizes datastores and latest snapshot", async () => {
  const id = await register("inv-pbs", "pbs", MOCK_PORT);
  const res = await app.inject({ method: "POST", url: `/api/nodes/${id}/sync` });
  expect(res.json().ok).toBe(true);
  expect(res.json().output).toContain("backups: 3 snapshots");
  expect(res.json().output).toContain(new Date(3000 * 1000).toISOString());
});

test("node.sync is audited per node", async () => {
  const id = await register("inv-audit", "pve", MOCK_PORT);
  await app.inject({ method: "POST", url: `/api/nodes/${id}/sync` });
  const rows = await prisma.auditEntry.findMany({
    where: { action: "node.sync", target: "inv-audit", ok: true },
  });
  expect(rows).toHaveLength(1);
});
