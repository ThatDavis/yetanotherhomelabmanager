import "./env.js";
import { randomBytes } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { buildServer } from "../src/app.js";
import { decrypt } from "../src/crypto.js";
import { prisma } from "../src/db.js";
import { loadSecret, rotateMasterKey, storeSecret } from "../src/secrets.js";

const app = buildServer({ spaDir: "/nonexistent", auth: false });

// Track exactly what this suite creates — cleanup deletes ONLY these rows.
// Prefix-based secret deletion has destroyed real operator secrets before.
const createdSecretIds: string[] = [];
let testNodeId: string | null = null;

async function store(id: string, value: string): Promise<void> {
  await storeSecret(id, value);
  createdSecretIds.push(id);
}

afterAll(async () => {
  await prisma.secret.deleteMany({ where: { id: { in: createdSecretIds } } });
  if (testNodeId) await prisma.node.deleteMany({ where: { id: testNodeId } });
  await prisma.auditEntry.deleteMany({ where: { action: { startsWith: "secrets." } } });
  await app.close();
});

test("list returns metadata only, never values", async () => {
  await store("sectest-alpha", "supersecret-value");
  const res = await app.inject({ method: "GET", url: "/api/secrets" });
  expect(res.statusCode).toBe(200);
  expect(JSON.stringify(res.json())).not.toContain("supersecret-value");
  expect(res.json().map((s: { id: string }) => s.id)).toContain("sectest-alpha");
});

test("rotate re-encrypts all secrets under the new key (and restores)", async () => {
  await store("sectest-rotate", "rotate-me");
  const newKey = randomBytes(32).toString("hex");
  try {
    const count = await rotateMasterKey(newKey);
    expect(count).toBeGreaterThan(0);

    // New key decrypts; old (env) key fails
    const row = await prisma.secret.findUnique({ where: { id: "sectest-rotate" } });
    if (!row) throw new Error("sectest-rotate missing");
    expect(decrypt(row, newKey)).toBe("rotate-me");
    expect(() => decrypt(row)).toThrow();
  } finally {
    // ALWAYS restore: rotation touches every secret in the (shared dev) DB
    await rotateMasterKey(process.env.MASTER_KEY as string, newKey);
  }
});

test("rotate endpoint rejects malformed keys", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/secrets/rotate-key",
    payload: { newMasterKey: "short" },
  });
  expect(res.statusCode).toBe(400);
});

test("delete refuses node tokens in use, allows orphan cleanup", async () => {
  const node = await prisma.node.create({
    data: { name: "sectest-node", type: "pve", url: "https://x:8006", tokenId: "a@pam!b" },
  });
  testNodeId = node.id;
  await store(`node-token-${node.id}`, "token");

  const refused = await app.inject({ method: "DELETE", url: `/api/secrets/node-token-${node.id}` });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error).toContain("in use");

  await prisma.node.delete({ where: { id: node.id } });
  testNodeId = null;
  const allowed = await app.inject({ method: "DELETE", url: `/api/secrets/node-token-${node.id}` });
  expect(allowed.statusCode).toBe(200);
  expect(await loadSecret(`node-token-${node.id}`)).toBeNull();
});

test("rotate (via endpoint) and delete are audited", async () => {
  const newKey = randomBytes(32).toString("hex");
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/secrets/rotate-key",
      payload: { newMasterKey: newKey },
    });
    expect(res.statusCode).toBe(200);
  } finally {
    await rotateMasterKey(process.env.MASTER_KEY as string, newKey);
  }

  const rows = await prisma.auditEntry.findMany({
    where: { action: { startsWith: "secrets." } },
    orderBy: { at: "asc" },
  });
  const actions = rows.map((r) => `${r.action}:${r.ok}`);
  expect(actions).toContain("secrets.rotate-key:true");
  expect(actions).toContain("secrets.delete:false");
  expect(actions).toContain("secrets.delete:true");
});
