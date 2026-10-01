import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { prisma } from "../db.js";
import { emailEnabled, sendAlert, smtpConfigured } from "../notify.js";

const EMAIL_ENABLED_KEY = "notify.email.enabled";

const webhookSchema = z.object({
  name: z.string().max(50).default(""),
  url: z.string().url().max(500),
  enabled: z.boolean().default(true),
});

const webhookUpdateSchema = webhookSchema.partial();

export function alertRoutes(app: FastifyInstance) {
  app.get("/api/alerts", async () => ({
    emailEnabled: await emailEnabled(),
    smtpConfigured: smtpConfigured(),
    webhooks: await prisma.webhook.findMany({ orderBy: { createdAt: "asc" } }),
  }));

  app.put("/api/alerts/email", async (req, reply) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    await prisma.setting.upsert({
      where: { key: EMAIL_ENABLED_KEY },
      create: { key: EMAIL_ENABLED_KEY, value: String(parsed.data.enabled) },
      update: { value: String(parsed.data.enabled) },
    });
    await audit({
      action: "alerts.email",
      params: { enabled: parsed.data.enabled },
      ok: true,
    });
    return { enabled: parsed.data.enabled };
  });

  app.post("/api/webhooks", async (req, reply) => {
    const parsed = webhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid webhook", details: parsed.error.issues });
    }
    const webhook = await prisma.webhook.create({ data: parsed.data });
    await audit({ action: "webhook.register", target: webhook.url, ok: true });
    return reply.code(201).send(webhook);
  });

  app.patch("/api/webhooks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.webhook.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "webhook not found" });
    const parsed = webhookUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid update", details: parsed.error.issues });
    }
    const fields: { name?: string; url?: string; enabled?: boolean } = {};
    if (parsed.data.name !== undefined) fields.name = parsed.data.name;
    if (parsed.data.url !== undefined) fields.url = parsed.data.url;
    if (parsed.data.enabled !== undefined) fields.enabled = parsed.data.enabled;
    const updated = await prisma.webhook.update({ where: { id }, data: fields });
    await audit({ action: "webhook.update", target: updated.url, params: parsed.data, ok: true });
    return updated;
  });

  app.delete("/api/webhooks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const webhook = await prisma.webhook.findUnique({ where: { id } });
    if (!webhook) return reply.code(404).send({ error: "webhook not found" });
    await prisma.webhook.delete({ where: { id } });
    await audit({ action: "webhook.remove", target: webhook.url, ok: true });
    return { removed: webhook.url };
  });

  // Manual test-send so the operator can verify an endpoint before relying on it.
  app.post("/api/webhooks/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const webhook = await prisma.webhook.findUnique({ where: { id } });
    if (!webhook) return reply.code(404).send({ error: "webhook not found" });
    const results = await sendAlert(
      {
        source: "target",
        name: "test",
        from: "test",
        to: "up",
        detail: "manual test from YAHLM alerts page",
      },
      { email: false, webhooks: [webhook] },
    );
    return { results };
  });
}
