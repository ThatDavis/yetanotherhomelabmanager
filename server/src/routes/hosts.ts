import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { prisma } from "../db.js";
import { bootstrapScript, masterPublicKey } from "../keys.js";
import { healthCheck } from "../steps.js";

const createHostSchema = z.object({
  alias: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, dashes"),
  hostname: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(64),
  notes: z.string().max(500).default(""),
});

export function hostRoutes(app: FastifyInstance) {
  app.get("/api/hosts", async () => prisma.host.findMany({ orderBy: { alias: "asc" } }));

  app.post("/api/hosts", async (req, reply) => {
    const parsed = createHostSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid host", details: parsed.error.issues });
    }
    const start = Date.now();
    try {
      const host = await prisma.host.create({ data: parsed.data });
      await audit({
        action: "host.register",
        target: host.alias,
        params: parsed.data,
        ok: true,
        durationMs: Date.now() - start,
      });
      return reply.code(201).send(host);
    } catch (err) {
      await audit({
        action: "host.register",
        target: parsed.data.alias,
        params: parsed.data,
        ok: false,
        output: (err as Error).message,
        durationMs: Date.now() - start,
      });
      return reply.code(409).send({ error: "alias already exists or invalid data" });
    }
  });

  app.delete("/api/hosts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const host = await prisma.host.findUnique({ where: { id } });
    if (!host) return reply.code(404).send({ error: "host not found" });
    const start = Date.now();
    await prisma.host.delete({ where: { id } });
    await audit({
      action: "host.remove",
      target: host.alias,
      ok: true,
      durationMs: Date.now() - start,
    });
    return { removed: host.alias };
  });

  app.get("/api/hosts/:id/bootstrap", async (req, reply) => {
    const { id } = req.params as { id: string };
    const host = await prisma.host.findUnique({ where: { id } });
    if (!host) return reply.code(404).send({ error: "host not found" });
    const script = bootstrapScript(await masterPublicKey());
    return reply.type("text/plain").send(script);
  });

  app.get("/api/master-key", async () => ({ publicKey: await masterPublicKey() }));

  app.post("/api/hosts/:id/probe", async (req, reply) => {
    const { id } = req.params as { id: string };
    const host = await prisma.host.findUnique({ where: { id } });
    if (!host) return reply.code(404).send({ error: "host not found" });
    return healthCheck(host);
  });
}
