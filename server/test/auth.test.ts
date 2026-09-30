import "./env.js";
import { randomBytes } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { buildServer } from "../src/app.js";
import { SESSION_COOKIE } from "../src/auth.js";
import { prisma } from "../src/db.js";

// Session/guard behavior. The WebAuthn ceremony itself is verified end-to-end
// in a real browser with a virtual authenticator (not unit-testable here).

const app = buildServer({ spaDir: "/nonexistent" });

async function makeSession(ttlMs = 60_000): Promise<string> {
  const token = randomBytes(48).toString("base64url");
  await prisma.session.create({ data: { id: token, expiresAt: new Date(Date.now() + ttlMs) } });
  return token;
}

const suiteStart = new Date();

afterAll(async () => {
  // Scoped: never wipe real operator credentials/sessions from the dev DB
  await prisma.session.deleteMany({ where: { createdAt: { gt: suiteStart } } });
  await prisma.credential.deleteMany({ where: { credentialId: "test-cred" } });
  await app.close();
});
test("API requires a session; /health and /api/auth/status are public", async () => {
  expect((await app.inject({ method: "GET", url: "/api/nodes" })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);

  const status = await app.inject({ method: "GET", url: "/api/auth/status" });
  expect(status.statusCode).toBe(200);
  // Field values depend on dev-DB state (real passkeys may exist); assert shape only
  expect(typeof status.json().registered).toBe("boolean");
  expect(status.json().authenticated).toBe(false);
});

test("bogus cookie is rejected; valid session accepted", async () => {
  const bogus = await app.inject({
    method: "GET",
    url: "/api/nodes",
    cookies: { [SESSION_COOKIE]: "nope" },
  });
  expect(bogus.statusCode).toBe(401);

  const token = await makeSession();
  const ok = await app.inject({
    method: "GET",
    url: "/api/nodes",
    cookies: { [SESSION_COOKIE]: token },
  });
  expect(ok.statusCode).toBe(200);
});

test("expired session is rejected and purged", async () => {
  const token = await makeSession(-1000);
  const res = await app.inject({
    method: "GET",
    url: "/api/nodes",
    cookies: { [SESSION_COOKIE]: token },
  });
  expect(res.statusCode).toBe(401);
  expect(await prisma.session.findUnique({ where: { id: token } })).toBeNull();
});

test("registration requires a session once any credential exists", async () => {
  // Simulate an existing passkey (first-run-open is covered by the browser lifecycle test)
  await prisma.credential.create({
    data: { credentialId: "test-cred", publicKey: "cHVrZXk", counter: 0n },
  });

  const closed = await app.inject({ method: "POST", url: "/api/auth/register/options" });
  expect(closed.statusCode).toBe(403);

  // But still allowed with a session (adding a second passkey)
  const token = await makeSession();
  const allowed = await app.inject({
    method: "POST",
    url: "/api/auth/register/options",
    cookies: { [SESSION_COOKIE]: token },
  });
  expect(allowed.statusCode).toBe(200);
});

test("logout destroys the session", async () => {
  const token = await makeSession();
  const out = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    cookies: { [SESSION_COOKIE]: token },
  });
  expect(out.statusCode).toBe(200);
  expect(await prisma.session.findUnique({ where: { id: token } })).toBeNull();

  const after = await app.inject({
    method: "GET",
    url: "/api/nodes",
    cookies: { [SESSION_COOKIE]: token },
  });
  expect(after.statusCode).toBe(401);
});
