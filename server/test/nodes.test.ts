import "./env.js";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildServer } from "../src/app.js";
import { prisma } from "../src/db.js";

// Mock PVE API over real TLS with a self-signed cert, exercising the actual
// certificate-fingerprint path in the client + node.test step.
// Fixed port so restarting the mock with a new cert keeps the node URL valid.

const MOCK_PORT = 18443;
const tmp = mkdtempSync(path.join(os.tmpdir(), "yahlm-pve-mock-"));
const app = buildServer({ spaDir: "/nonexistent" });

let mock: https.Server;
let authSeen = "";
let failAuth = false;
let denyPrivileges = false;
let nameSeq = 0;

const createdIds: string[] = [];

function makeCert(name: string): { key: string; cert: string } {
  const keyPath = path.join(tmp, `${name}.key`);
  const certPath = path.join(tmp, `${name}.crt`);
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyPath} -out ${certPath} -days 1 -subj /CN=${name}`,
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
}

async function startMock(certName: string): Promise<void> {
  mock = https.createServer(makeCert(certName), (req, res) => {
    authSeen = req.headers.authorization ?? "";
    res.setHeader("content-type", "application/json");
    if (failAuth) {
      res.writeHead(401).end(JSON.stringify({ errors: "auth" }));
      return;
    }
    if (req.url === "/api2/json/version") {
      res.writeHead(200).end(JSON.stringify({ data: { version: "8.2.2" } }));
      return;
    }
    if (req.url === "/api2/json/nodes") {
      if (denyPrivileges) res.writeHead(403).end(JSON.stringify({ errors: "perm" }));
      else res.writeHead(200).end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(404).end("{}");
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  mock.listen(MOCK_PORT, "127.0.0.1", resolve);
  await promise;
}

async function stopMock(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  mock.close(() => resolve());
  await promise;
}

async function registerNode(): Promise<string> {
  const name = `mock-pve-${++nameSeq}`;
  const res = await app.inject({
    method: "POST",
    url: "/api/nodes",
    payload: {
      name,
      type: "pve",
      url: `https://127.0.0.1:${MOCK_PORT}`,
      tokenId: "yahlm@pam!api",
      tokenSecret: "secret-uuid",
    },
  });
  expect(res.statusCode).toBe(201);
  createdIds.push(res.json().id);
  return res.json().id;
}

beforeAll(async () => {
  await startMock("cert-a");
});

afterAll(async () => {
  await stopMock();
  await prisma.node.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.secret.deleteMany({
    where: { id: { in: createdIds.map((id) => `node-token-${id}`) } },
  });
  await prisma.auditEntry.deleteMany({ where: { target: { startsWith: "mock-pve-" } } });
  await app.close();
});

test("full TOFU flow: register → test pins fingerprint → mismatch on new cert → unpin → re-pin", async () => {
  const id = await registerNode();

  const first = await app.inject({ method: "POST", url: `/api/nodes/${id}/test` });
  expect(first.json().output).toContain("tofu: pinned");
  expect(first.json().output).toContain("8.2.2");
  const pinned = (await prisma.node.findUnique({ where: { id } }))?.tlsFingerprint;
  expect(pinned).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

  // Token auth header reached the server in PVE '=' form
  expect(authSeen).toBe("PVEAPIToken=yahlm@pam!api=secret-uuid");

  // Regression: consecutive requests against the same cert must not fail
  // fingerprint verification (TLS session resumption used to return an
  // empty peer certificate → spurious mismatch)
  const again = await app.inject({ method: "POST", url: `/api/nodes/${id}/test` });
  expect(again.json().ok).toBe(true);
  expect(again.json().output).not.toContain("MISMATCH");

  // Server now presents a different certificate — must hard-fail
  await stopMock();
  await startMock("cert-b");
  const second = await app.inject({ method: "POST", url: `/api/nodes/${id}/test` });
  expect(second.json().ok).toBe(false);
  expect(second.json().output).toContain("FINGERPRINT MISMATCH");

  // Unpin and re-test — re-pins the new cert
  await app.inject({ method: "POST", url: `/api/nodes/${id}/unpin` });
  const third = await app.inject({ method: "POST", url: `/api/nodes/${id}/test` });
  expect(third.json().ok).toBe(true);
  const repinned = (await prisma.node.findUnique({ where: { id } }))?.tlsFingerprint;
  expect(repinned).not.toBe(pinned);

  // Restore cert-a for the remaining tests
  await stopMock();
  await startMock("cert-a");
});

test("401 surfaces as auth failure", async () => {
  failAuth = true;
  const id = await registerNode();
  const res = await app.inject({ method: "POST", url: `/api/nodes/${id}/test` });
  expect(res.json().ok).toBe(false);
  expect(res.json().output).toContain("authentication failed (401)");
  failAuth = false;
});

test("403 on privilege probe surfaces insufficient privileges", async () => {
  denyPrivileges = true;
  const id = await registerNode();
  const res = await app.inject({ method: "POST", url: `/api/nodes/${id}/test` });
  expect(res.json().ok).toBe(false);
  expect(res.json().output).toContain("INSUFFICIENT PRIVILEGES");
  denyPrivileges = false;
});

test("token secret is stored encrypted and never returned by the API", async () => {
  const id = await registerNode();
  const secret = await prisma.secret.findUnique({ where: { id: `node-token-${id}` } });
  expect(secret?.ciphertext).toBeTruthy();
  expect(secret?.ciphertext).not.toContain("secret-uuid");

  const list = await app.inject({ method: "GET", url: "/api/nodes" });
  expect(JSON.stringify(list.json())).not.toContain("secret-uuid");
});

test("node.test steps are audited", async () => {
  const id = await registerNode();
  await app.inject({ method: "POST", url: `/api/nodes/${id}/test` });
  const node = await prisma.node.findUnique({ where: { id } });
  const rows = await prisma.auditEntry.findMany({
    where: { action: "node.test", target: node?.name },
  });
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0]?.ok).toBe(true);
});
