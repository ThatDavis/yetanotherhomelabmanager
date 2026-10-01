import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { prisma } from "../db.js";
import { scheduleTarget } from "../scheduler.js";
import { pingCheck } from "../steps.js";

const targetSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, dashes"),
  host: z.string().min(1).max(255),
  intervalSec: z.number().int().min(10).max(86400).default(60),
  alertAfter: z.number().int().min(1).max(100).default(3),
  enabled: z.boolean().default(true),
});

const updateSchema = targetSchema.partial();

export function targetRoutes(app: FastifyInstance) {
  app.get("/api/targets", async () => {
    const targets = await prisma.pingTarget.findMany({
      include: { results: { orderBy: { at: "desc" }, take: 10 } },
      orderBy: { name: "asc" },
    });
    // Uptime % over the retained history window (7 days)
    const counts = await prisma.checkResult.groupBy({
      by: ["targetId", "ok"],
      _count: { _all: true },
    });
    const uptime: Record<string, number | null> = {};
    for (const t of targets) uptime[t.id] = null;
    const totals: Record<string, number> = {};
    const oks: Record<string, number> = {};
    for (const row of counts) {
      totals[row.targetId] = (totals[row.targetId] ?? 0) + row._count._all;
      if (row.ok) oks[row.targetId] = row._count._all;
    }
    for (const t of targets) {
      const total = totals[t.id];
      uptime[t.id] = total ? Math.round(((oks[t.id] ?? 0) / total) * 1000) / 10 : null;
    }
    return targets.map((t) => ({ ...t, uptimePct: uptime[t.id] }));
  });

  app.get("/api/targets/:id/detail", async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await prisma.pingTarget.findUnique({
      where: { id },
      include: { results: { orderBy: { at: "desc" }, take: 50 } },
    });
    if (!target) return reply.code(404).send({ error: "target not found" });
    const transitions = await prisma.auditEntry.findMany({
      where: { action: "ping.transition", target: target.name },
      orderBy: { at: "desc" },
      take: 10,
    });
    return { ...target, transitions };
  });

  app.post("/api/targets", async (req, reply) => {
    const parsed = targetSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid target", details: parsed.error.issues });
    }
    try {
      const target = await prisma.pingTarget.create({ data: parsed.data });
      await audit({
        action: "target.register",
        target: target.name,
        params: parsed.data,
        ok: true,
      });
      await scheduleTarget(target.id);
      return reply.code(201).send(target);
    } catch (err) {
      await audit({
        action: "target.register",
        target: parsed.data.name,
        ok: false,
        output: (err as Error).message,
      });
      return reply.code(409).send({ error: "name already exists or invalid data" });
    }
  });

  app.patch("/api/targets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.pingTarget.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "target not found" });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid update", details: parsed.error.issues });
    }
    const fields: {
      name?: string;
      host?: string;
      intervalSec?: number;
      alertAfter?: number;
      enabled?: boolean;
    } = {};
    if (parsed.data.name !== undefined) fields.name = parsed.data.name;
    if (parsed.data.host !== undefined) fields.host = parsed.data.host;
    if (parsed.data.intervalSec !== undefined) fields.intervalSec = parsed.data.intervalSec;
    if (parsed.data.alertAfter !== undefined) fields.alertAfter = parsed.data.alertAfter;
    if (parsed.data.enabled !== undefined) fields.enabled = parsed.data.enabled;
    const updated = await prisma.pingTarget.update({ where: { id }, data: fields });
    await audit({ action: "target.update", target: updated.name, params: fields, ok: true });
    await scheduleTarget(id);
    return updated;
  });

  app.delete("/api/targets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await prisma.pingTarget.findUnique({ where: { id } });
    if (!target) return reply.code(404).send({ error: "target not found" });
    await prisma.pingTarget.delete({ where: { id } });
    await audit({ action: "target.remove", target: target.name, ok: true });
    await scheduleTarget(id); // stops its timer
    return { removed: target.name };
  });

  app.post("/api/targets/:id/check", async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = await prisma.pingTarget.findUnique({ where: { id } });
    if (!target) return reply.code(404).send({ error: "target not found" });
    return pingCheck(target);
  });
}
