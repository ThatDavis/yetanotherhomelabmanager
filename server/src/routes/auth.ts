import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import type { FastifyInstance } from "fastify";
import { audit } from "../audit.js";
import {
  createSession,
  destroySession,
  ORIGIN,
  RP_ID,
  RP_NAME,
  sessionValid,
  setChallenge,
  takeChallenge,
} from "../auth.js";
import { prisma } from "../db.js";

export function authRoutes(app: FastifyInstance) {
  // Public: used by the SPA to decide between login and register views.
  app.get("/api/auth/status", async (req) => ({
    registered: (await prisma.credential.count()) > 0,
    authenticated: await sessionValid(req),
  }));

  app.post("/api/auth/register/options", async (req, reply) => {
    const hasCredentials = (await prisma.credential.count()) > 0;
    // First-run registration is open; afterwards requires a session (2026-09-30 decision)
    if (hasCredentials && !(await sessionValid(req))) {
      return reply.code(403).send({ error: "registration requires an authenticated session" });
    }
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: "operator",
      userDisplayName: "Operator",
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    const challengeKey = setChallenge("register", options.challenge);
    return { ...options, challengeKey };
  });

  app.post("/api/auth/register/verify", async (req, reply) => {
    const body = req.body as {
      challengeKey?: string;
      response?: Parameters<typeof verifyRegistrationResponse>[0]["response"];
    };
    if (!body.challengeKey || !body.response)
      return reply.code(400).send({ error: "missing challengeKey or response" });
    const expected = takeChallenge(body.challengeKey);
    if (!expected) return reply.code(400).send({ error: "challenge expired or unknown — retry" });

    const hasCredentials = (await prisma.credential.count()) > 0;
    if (hasCredentials && !(await sessionValid(req))) {
      return reply.code(403).send({ error: "registration requires an authenticated session" });
    }

    let verification: VerifiedRegistrationResponse;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: expected,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
      });
    } catch (err) {
      await audit({ action: "auth.register", ok: false, output: (err as Error).message });
      return reply.code(400).send({ error: `registration failed: ${(err as Error).message}` });
    }

    const { registrationInfo } = verification;
    if (!verification.verified || !registrationInfo) {
      await audit({ action: "auth.register", ok: false, output: "verification rejected" });
      return reply.code(400).send({ error: "registration verification rejected" });
    }

    const { credential } = registrationInfo;
    const name = (req.body as { name?: string }).name ?? "";
    await prisma.credential.create({
      data: {
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: BigInt(credential.counter),
        transports: (credential.transports ?? []).join(","),
        name,
      },
    });
    await audit({ action: "auth.register", target: name || "passkey", ok: true });
    await createSession(reply); // auto-login after registration
    return { verified: true };
  });

  app.post("/api/auth/login/options", async (_req, reply) => {
    const credentials = await prisma.credential.findMany({
      select: { credentialId: true, transports: true },
    });
    if (credentials.length === 0) return reply.code(400).send({ error: "no passkey registered" });
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: credentials.map((c) => ({
        id: c.credentialId,
        transports: c.transports
          ? (c.transports.split(",") as ("usb" | "nfc" | "ble" | "internal" | "hybrid")[])
          : [],
      })),
      userVerification: "preferred",
    });
    const challengeKey = setChallenge("login", options.challenge);
    return { ...options, challengeKey };
  });

  app.post("/api/auth/login/verify", async (req, reply) => {
    const body = req.body as {
      challengeKey?: string;
      response?: Parameters<typeof verifyAuthenticationResponse>[0]["response"];
    };
    if (!body.challengeKey || !body.response)
      return reply.code(400).send({ error: "missing challengeKey or response" });
    const expected = takeChallenge(body.challengeKey);
    if (!expected) return reply.code(400).send({ error: "challenge expired or unknown — retry" });

    const credential = await prisma.credential.findUnique({
      where: { credentialId: body.response.id },
    });
    if (!credential) {
      await audit({ action: "auth.login", ok: false, output: "unknown credential" });
      return reply.code(400).send({ error: "unknown credential" });
    }

    let verification: VerifiedAuthenticationResponse;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: expected,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: {
          id: credential.credentialId,
          publicKey: Buffer.from(credential.publicKey, "base64url"),
          counter: Number(credential.counter),
          transports: credential.transports
            ? (credential.transports.split(",") as (
                | "usb"
                | "nfc"
                | "ble"
                | "internal"
                | "hybrid"
              )[])
            : [],
        },
      });
    } catch (err) {
      await audit({
        action: "auth.login",
        target: credential.name,
        ok: false,
        output: (err as Error).message,
      });
      return reply.code(400).send({ error: `login failed: ${(err as Error).message}` });
    }

    if (!verification.verified) {
      await audit({
        action: "auth.login",
        target: credential.name,
        ok: false,
        output: "verification rejected",
      });
      return reply.code(400).send({ error: "login verification rejected" });
    }

    await prisma.credential.update({
      where: { id: credential.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() },
    });
    await audit({ action: "auth.login", target: credential.name || "passkey", ok: true });
    await createSession(reply);
    return { verified: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await destroySession(req, reply);
    return { loggedOut: true };
  });

  app.get("/api/auth/credentials", async (req, reply) => {
    if (!(await sessionValid(req)))
      return reply.code(401).send({ error: "authentication required" });
    return prisma.credential.findMany({
      select: { id: true, name: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: "asc" },
    });
  });
}
