import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { prisma } from "../db.js";
import { enqueueUpdateJob } from "../jobs.js";

const scheduleSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, dashes"),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, server-local time"),
  osUpdates: z.boolean().default(true),
  containerUpdates: z.boolean().default(false),
  enabled: z.boolean().default(true),
  hostIds: z.array(z.string()).default([]),
});

// Plain optionals — .partial() on a schema with .default() fields re-applies
// the defaults to omitted keys, silently resetting them on update.
const updateSchema = z.object({
  name: scheduleSchema.shape.name.optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  timeOfDay: scheduleSchema.shape.timeOfDay.optional(),
  osUpdates: z.boolean().optional(),
  containerUpdates: z.boolean().optional(),
  enabled: z.boolean().optional(),
  hostIds: z.array(z.string()).optional(),
});

const hostSelect = { select: { id: true, alias: true, hostname: true, self: true } };

export function scheduleRoutes(app: FastifyInstance) {
  app.get("/api/schedules", async () => {
    return prisma.updateSchedule.findMany({
      include: { hosts: hostSelect, jobs: { orderBy: { startedAt: "desc" }, take: 1 } },
      orderBy: { name: "asc" },
    });
  });

  app.post("/api/schedules", async (req, reply) => {
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid schedule", details: parsed.error.issues });
    }
    try {
      const { hostIds, ...data } = parsed.data;
      const schedule = await prisma.updateSchedule.create({
        data: { ...data, hosts: { connect: hostIds.map((id) => ({ id })) } },
        include: { hosts: hostSelect },
      });
      await audit({
        action: "schedule.create",
        target: schedule.name,
        params: parsed.data,
        ok: true,
      });
      return reply.code(201).send(schedule);
    } catch (err) {
      await audit({
        action: "schedule.create",
        target: parsed.data.name,
        ok: false,
        output: (err as Error).message,
      });
      return reply.code(409).send({ error: "name already exists or unknown host id" });
    }
  });

  app.patch("/api/schedules/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.updateSchedule.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "schedule not found" });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid schedule", details: parsed.error.issues });
    }
    const fields: {
      name?: string;
      daysOfWeek?: number[];
      timeOfDay?: string;
      osUpdates?: boolean;
      containerUpdates?: boolean;
      enabled?: boolean;
    } = {};
    if (parsed.data.name !== undefined) fields.name = parsed.data.name;
    if (parsed.data.daysOfWeek !== undefined) fields.daysOfWeek = parsed.data.daysOfWeek;
    if (parsed.data.timeOfDay !== undefined) fields.timeOfDay = parsed.data.timeOfDay;
    if (parsed.data.osUpdates !== undefined) fields.osUpdates = parsed.data.osUpdates;
    if (parsed.data.containerUpdates !== undefined)
      fields.containerUpdates = parsed.data.containerUpdates;
    if (parsed.data.enabled !== undefined) fields.enabled = parsed.data.enabled;
    const schedule = await prisma.updateSchedule.update({
      where: { id },
      data: {
        ...fields,
        // Replace the full host selection whenever hostIds is sent.
        ...(parsed.data.hostIds !== undefined
          ? { hosts: { set: parsed.data.hostIds.map((hid) => ({ id: hid })) } }
          : {}),
      },
      include: { hosts: hostSelect },
    });
    await audit({
      action: "schedule.update",
      target: schedule.name,
      params: parsed.data,
      ok: true,
    });
    return schedule;
  });

  app.delete("/api/schedules/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const schedule = await prisma.updateSchedule.findUnique({ where: { id } });
    if (!schedule) return reply.code(404).send({ error: "schedule not found" });
    await prisma.updateSchedule.delete({ where: { id } });
    await audit({ action: "schedule.remove", target: schedule.name, ok: true });
    return { removed: schedule.name };
  });

  // Manual run — the UI shows a pre-flight summary before calling this.
  app.post("/api/schedules/:id/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const schedule = await prisma.updateSchedule.findUnique({
      where: { id },
      include: { hosts: true },
    });
    if (!schedule) return reply.code(404).send({ error: "schedule not found" });
    const jobId = await enqueueUpdateJob(id, "manual");
    await audit({
      action: "schedule.run",
      target: schedule.name,
      params: { hosts: schedule.hosts.map((h) => h.alias) },
      ok: true,
    });
    return reply.code(202).send({ jobId });
  });
}
