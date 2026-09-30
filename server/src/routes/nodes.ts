import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { prisma } from "../db.js";
import { storeSecret } from "../secrets.js";
import { nodeTest } from "../steps.js";

const createNodeSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, dashes"),
  type: z.enum(["pve", "pbs"]),
  url: z.string().url().max(255),
  tokenId: z.string().min(1).max(255), // user@realm!tokenname
  tokenSecret: z.string().min(1).max(255),
});

const updateNodeSchema = createNodeSchema
  .partial()
  .omit({ tokenSecret: true })
  .extend({
    tokenSecret: z.string().min(1).max(255).optional(),
  });

function secretId(nodeId: string): string {
  return `node-token-${nodeId}`;
}

export function nodeRoutes(app: FastifyInstance) {
  app.get("/api/nodes", async () => prisma.node.findMany({ orderBy: { name: "asc" } }));

  app.post("/api/nodes", async (req, reply) => {
    const parsed = createNodeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid node", details: parsed.error.issues });
    }
    const { tokenSecret, ...fields } = parsed.data;
    const start = Date.now();
    try {
      const node = await prisma.node.create({ data: fields });
      await storeSecret(secretId(node.id), tokenSecret);
      await audit({
        action: "node.register",
        target: node.name,
        params: { ...fields, tokenSecret: "[redacted]" },
        ok: true,
        durationMs: Date.now() - start,
      });
      return reply.code(201).send(node);
    } catch (err) {
      await audit({
        action: "node.register",
        target: fields.name,
        params: { ...fields, tokenSecret: "[redacted]" },
        ok: false,
        output: (err as Error).message,
        durationMs: Date.now() - start,
      });
      return reply.code(409).send({ error: "name already exists or invalid data" });
    }
  });

  app.patch("/api/nodes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const node = await prisma.node.findUnique({ where: { id } });
    if (!node) return reply.code(404).send({ error: "node not found" });
    const parsed = updateNodeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid update", details: parsed.error.issues });
    }
    const { tokenSecret, ...raw } = parsed.data;
    // exactOptionalPropertyTypes: build the update explicitly, no undefined values
    const fields: { name?: string; type?: string; url?: string; tokenId?: string } = {};
    if (raw.name !== undefined) fields.name = raw.name;
    if (raw.type !== undefined) fields.type = raw.type;
    if (raw.url !== undefined) fields.url = raw.url;
    if (raw.tokenId !== undefined) fields.tokenId = raw.tokenId;
    // URL changes invalidate the pinned fingerprint (different server possible)
    const tlsFingerprint = fields.url && fields.url !== node.url ? "" : node.tlsFingerprint;
    const updated = await prisma.node.update({
      where: { id },
      data: { ...fields, tlsFingerprint },
    });
    if (tokenSecret) await storeSecret(secretId(id), tokenSecret);
    await audit({
      action: "node.update",
      target: node.name,
      params: { ...fields, tokenSecret: tokenSecret ? "[rotated]" : undefined },
      ok: true,
    });
    return updated;
  });

  app.delete("/api/nodes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const node = await prisma.node.findUnique({ where: { id } });
    if (!node) return reply.code(404).send({ error: "node not found" });
    await prisma.node.delete({ where: { id } });
    await prisma.secret.deleteMany({ where: { id: secretId(id) } });
    await audit({ action: "node.remove", target: node.name, ok: true });
    return { removed: node.name };
  });

  // Clear the TOFU-pinned fingerprint; next test re-pins. Audited.
  app.post("/api/nodes/:id/unpin", async (req, reply) => {
    const { id } = req.params as { id: string };
    const node = await prisma.node.findUnique({ where: { id } });
    if (!node) return reply.code(404).send({ error: "node not found" });
    await prisma.node.update({ where: { id }, data: { tlsFingerprint: "" } });
    await audit({ action: "node.unpin", target: node.name, ok: true });
    return { unpinned: node.name };
  });

  app.post("/api/nodes/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const node = await prisma.node.findUnique({ where: { id } });
    if (!node) return reply.code(404).send({ error: "node not found" });
    return nodeTest(node);
  });
}
