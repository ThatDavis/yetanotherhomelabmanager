import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "./db.js";

// WebAuthn / session configuration. RP_ID and ORIGIN must match the public
// origin exactly or browsers refuse the ceremony (docs/UI.md failure modes).

export const RP_ID = process.env.RP_ID ?? "localhost";
export const ORIGIN = process.env.ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`;
export const RP_NAME = "Yet Another Home Lab Manager";

export const SESSION_COOKIE = "yahlm_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (2026-09-30 decision)

// Ceremony challenges are short-lived (5 min) and kept in memory: a restart
// just means the operator retries the ceremony.
export const challenges = new Map<string, { challenge: string; expiresAt: number }>();

export function setChallenge(kind: string, challenge: string): string {
  const key = `${kind}:${randomBytes(16).toString("base64url")}`;
  challenges.set(key, { challenge, expiresAt: Date.now() + 5 * 60 * 1000 });
  return key;
}

export function takeChallenge(key: string): string | null {
  const entry = challenges.get(key);
  challenges.delete(key);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.challenge;
}

export async function createSession(reply: FastifyReply): Promise<void> {
  const token = randomBytes(48).toString("base64url");
  await prisma.session.create({
    data: { id: token, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: ORIGIN.startsWith("https"),
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await prisma.session.deleteMany({ where: { id: token } });
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function sessionValid(req: FastifyRequest): Promise<boolean> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return false;
  const session = await prisma.session.findUnique({ where: { id: token } });
  if (!session) return false;
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: token } });
    return false;
  }
  return true;
}

// Only /api/* requires a session — static assets and the SPA (incl. /login)
// must load unauthenticated; the SPA redirects to /login client-side on 401.
const PUBLIC_PREFIXES = ["/health", "/api/auth/"];

export async function authGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.url.startsWith("/api")) return;
  if (PUBLIC_PREFIXES.some((p) => req.url.startsWith(p))) return;
  if (!(await sessionValid(req))) {
    return reply.code(401).send({ error: "authentication required" });
  }
}
