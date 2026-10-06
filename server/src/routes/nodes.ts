import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { prisma } from "../db.js";
import { storeSecret } from "../secrets.js";
import { guestAgentIps, nodeSync, nodeTest } from "../steps.js";

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

/** Fill in the default Proxmox port when the URL has none (pve 8006 / pbs 8007). */
function withDefaultPort(url: string, type: "pve" | "pbs"): string {
  const u = new URL(url);
  if (!u.port) u.port = type === "pbs" ? "8007" : "8006";
  return u.toString().replace(/\/$/, "");
}

export function nodeRoutes(app: FastifyInstance) {
  app.get("/api/nodes", async () => prisma.node.findMany({ orderBy: { name: "asc" } }));

  app.post("/api/nodes", async (req, reply) => {
    const parsed = createNodeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid node", details: parsed.error.issues });
    }
    const { tokenSecret, ...raw } = parsed.data;
    const fields = { ...raw, url: withDefaultPort(raw.url, raw.type) };
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
    if (raw.url !== undefined) {
      const effectiveType = raw.type ?? (node.type === "pbs" ? "pbs" : "pve");
      fields.url = withDefaultPort(raw.url, effectiveType);
    }
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

  app.post("/api/nodes/:id/sync", async (req, reply) => {
    const { id } = req.params as { id: string };
    const node = await prisma.node.findUnique({ where: { id } });
    if (!node) return reply.code(404).send({ error: "node not found" });
    return nodeSync(node);
  });

  // One-click SSH host onboarding: the hostname comes from the node URL
  // (already operator-verified at registration), so nothing needs typing.
  // Idempotent — returns the existing host when this node is already
  // registered. The bootstrap script still runs once on the host itself:
  // Proxmox has no exec/file-write API to push the master key remotely.
  app.post("/api/nodes/:id/register-host", async (req, reply) => {
    const { id } = req.params as { id: string };
    const node = await prisma.node.findUnique({ where: { id } });
    if (!node) return reply.code(404).send({ error: "node not found" });
    let hostname: string;
    try {
      hostname = new URL(node.url).hostname;
    } catch {
      await audit({
        action: "node.host-register",
        target: node.name,
        ok: false,
        output: `node URL is not parseable: ${node.url}`,
      });
      return reply.code(400).send({ error: "node URL is not parseable" });
    }
    const alias = node.name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const existing = await prisma.host.findFirst({
      where: { OR: [{ alias }, { hostname }] },
    });
    if (existing) return { host: existing, existing: true };
    const host = await prisma.host.create({
      data: { alias, hostname, username: "root", notes: `registered from node ${node.name}` },
    });
    await audit({
      action: "node.host-register",
      target: node.name,
      params: { alias, hostname },
      ok: true,
    });
    return reply.code(201).send({ host, existing: false });
  });

  // QEMU guest-agent IP discovery for SSH host onboarding (M3.5).
  app.get("/api/nodes/:id/agent-ips", async (req, reply) => {
    const { id } = req.params as { id: string };
    const node = await prisma.node.findUnique({ where: { id } });
    if (!node) return reply.code(404).send({ error: "node not found" });
    return guestAgentIps(node);
  });

  // Sync all nodes; per-node failure isolation — one bad node can't blank the rest.
  app.post("/api/sync", async () => {
    const nodes = await prisma.node.findMany({ orderBy: { name: "asc" } });
    const results = [];
    for (const node of nodes) {
      const res = await nodeSync(node); // audited individually as node.sync
      results.push({ node: node.name, ok: res.ok, output: res.output });
    }
    return { ok: results.every((r) => r.ok), results };
  });

  app.get("/api/guests", async () => {
    const guests = await prisma.guest.findMany({ orderBy: [{ nodeDbId: "asc" }, { vmid: "asc" }] });
    const nodes = await prisma.node.findMany({ select: { id: true, name: true } });
    const nameById: Record<string, string> = {};
    for (const n of nodes) nameById[n.id] = n.name;
    return guests.map((g) => ({ ...g, nodeName: nameById[g.nodeDbId] ?? "?" }));
  });
}
