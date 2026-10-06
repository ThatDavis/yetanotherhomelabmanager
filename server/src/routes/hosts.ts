import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { prisma } from "../db.js";
import { enqueueRebootJob } from "../jobs.js";
import { bootstrapScript, masterPublicKey } from "../keys.js";
import { osCheck, stacksScan } from "../stacks.js";
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
  self: z.boolean().default(false),
});

const serviceSchema = z.object({
  name: z.string().min(1).max(50),
  port: z.number().int().min(1).max(65535),
});

const updateHostSchema = z.object({
  notes: z.string().max(500).optional(),
  self: z.boolean().optional(),
  bootOrder: z.number().int().min(0).max(999).optional(),
  // Wholesale replace of the host's declared services (M3.3).
  services: z.array(serviceSchema).max(20).optional(),
});

export function hostRoutes(app: FastifyInstance) {
  app.get("/api/hosts", async () =>
    prisma.host.findMany({
      include: { services: { orderBy: { name: "asc" } } },
      orderBy: { alias: "asc" },
    }),
  );

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

  app.patch("/api/hosts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.host.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "host not found" });
    const parsed = updateHostSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid host", details: parsed.error.issues });
    }
    const fields: { notes?: string; self?: boolean; bootOrder?: number } = {};
    if (parsed.data.notes !== undefined) fields.notes = parsed.data.notes;
    if (parsed.data.self !== undefined) fields.self = parsed.data.self;
    if (parsed.data.bootOrder !== undefined) fields.bootOrder = parsed.data.bootOrder;
    const host = await prisma.$transaction(async (tx) => {
      const updated = await tx.host.update({ where: { id }, data: fields });
      if (parsed.data.services !== undefined) {
        await tx.hostService.deleteMany({ where: { hostId: id } });
        await tx.hostService.createMany({
          data: parsed.data.services.map((s) => ({ hostId: id, name: s.name, port: s.port })),
        });
      }
      return updated;
    });
    await audit({
      action: "host.update",
      target: host.alias,
      params: parsed.data,
      ok: true,
    });
    return host;
  });

  // M3.6: refresh cached stack inventory + OS pending count for one host.
  app.post("/api/hosts/:id/scan", async (req, reply) => {
    const { id } = req.params as { id: string };
    const host = await prisma.host.findUnique({ where: { id } });
    if (!host) return reply.code(404).send({ error: "host not found" });
    const stacks = await stacksScan(host);
    const os = await osCheck(host);
    return { stacks, os };
  });

  app.post("/api/hosts/:id/reboot", async (req, reply) => {
    const { id } = req.params as { id: string };
    const host = await prisma.host.findUnique({ where: { id } });
    if (!host) return reply.code(404).send({ error: "host not found" });
    if (host.self) {
      // Rebooting the app's own host would kill the orchestrator mid-job.
      await audit({
        action: "host.reboot",
        target: host.alias,
        ok: false,
        output: "refused: this host runs the app — reboot it manually",
      });
      return reply.code(409).send({ error: "this host runs the app — reboot refused" });
    }
    const jobId = await enqueueRebootJob([host.id], "manual");
    await audit({ action: "host.reboot", target: host.alias, params: { manual: true }, ok: true });
    return reply.code(202).send({ jobId });
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
