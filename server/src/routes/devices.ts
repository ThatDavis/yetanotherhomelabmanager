import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { prisma } from "../db.js";
import { deleteSecret, loadSecret, storeSecret } from "../secrets.js";
import { identify, type SnmpCreds } from "../snmp.js";

// NOC.1: SNMP device registration. Profile credentials go to the Secret store
// (never the Device tables); identify/test run live SNMP and are audited.

const profileBody = z.object({
  name: z.string().min(1),
  version: z.enum(["v2c", "v3"]),
  port: z.number().int().min(1).max(65535).default(161),
  // creds present on create; absent on metadata-only edits
  creds: z
    .union([
      z.object({ version: z.literal("v2c"), community: z.string().min(1) }),
      z.object({
        version: z.literal("v3"),
        user: z.string().min(1),
        authProto: z.enum(["md5", "sha", "sha256", "sha512"]),
        authKey: z.string().min(8),
        privProto: z.enum(["aes", "aes256"]),
        privKey: z.string().min(8),
      }),
    ])
    .optional(),
});

const deviceBody = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  profileId: z.string().min(1),
});

async function credsFor(deviceId: string): Promise<{ creds: SnmpCreds; port: number } | null> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    include: { profile: true },
  });
  if (!device) return null;
  const raw = await loadSecret(device.profile.secretRef);
  if (!raw) return null;
  try {
    return { creds: JSON.parse(raw) as SnmpCreds, port: device.profile.port };
  } catch {
    return null;
  }
}

export function deviceRoutes(app: FastifyInstance) {
  // --- profiles (metadata only — never decrypted creds) ---
  app.get("/api/snmp-profiles", async () =>
    prisma.snmpProfile.findMany({
      select: {
        id: true,
        name: true,
        version: true,
        port: true,
        _count: { select: { devices: true } },
      },
      orderBy: { name: "asc" },
    }),
  );

  app.post("/api/snmp-profiles", async (req, reply) => {
    const parsed = profileBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    if (!parsed.data.creds) return reply.code(400).send({ error: "creds required" });
    const secretRef = `snmp-profile-${crypto.randomUUID()}`;
    await storeSecret(secretRef, JSON.stringify(parsed.data.creds));
    const profile = await prisma.snmpProfile.create({
      data: {
        name: parsed.data.name,
        version: parsed.data.version,
        port: parsed.data.port,
        secretRef,
      },
    });
    await audit({
      action: "snmpProfile.create",
      target: profile.name,
      params: { version: profile.version },
      ok: true,
    });
    return { id: profile.id, name: profile.name, version: profile.version, port: profile.port };
  });

  app.delete("/api/snmp-profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const profile = await prisma.snmpProfile.findUnique({
      where: { id },
      include: { _count: { select: { devices: true } } },
    });
    if (!profile) return reply.code(404).send({ error: "profile not found" });
    if (profile._count.devices > 0)
      return reply.code(409).send({ error: "profile in use by devices" });
    await prisma.snmpProfile.delete({ where: { id } });
    await deleteSecret(profile.secretRef);
    await audit({ action: "snmpProfile.delete", target: profile.name, ok: true });
    return { ok: true };
  });

  // --- devices ---
  app.get("/api/devices", async () => {
    const devices = await prisma.device.findMany({
      include: {
        profile: { select: { id: true, name: true, version: true } },
        _count: { select: { interfaces: true } },
      },
      orderBy: { name: "asc" },
    });
    return devices.map((d) => ({
      ...d,
      interfaces: undefined,
      interfaceCount: d._count.interfaces,
    }));
  });

  app.get("/api/devices/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const device = await prisma.device.findUnique({
      where: { id },
      include: {
        profile: { select: { id: true, name: true, version: true, port: true } },
        interfaces: { orderBy: { ifIndex: "asc" } },
      },
    });
    if (!device) return reply.code(404).send({ error: "device not found" });
    return {
      ...device,
      speedBps: undefined,
      interfaces: device.interfaces.map((i) => ({ ...i, speedBps: i.speedBps.toString() })),
    };
  });

  app.post("/api/devices", async (req, reply) => {
    const parsed = deviceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const device = await prisma.device.create({ data: parsed.data });
    await audit({
      action: "device.create",
      target: device.name,
      params: { address: device.address },
      ok: true,
    });
    return device;
  });

  app.put("/api/devices/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = deviceBody.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    // exactOptionalPropertyTypes: drop absent keys before handing to prisma
    const data = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    const device = await prisma.device.update({ where: { id }, data }).catch(() => null);
    if (!device) return reply.code(404).send({ error: "device not found" });
    await audit({ action: "device.update", target: device.name, params: parsed.data, ok: true });
    return device;
  });

  app.delete("/api/devices/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const device = await prisma.device.findUnique({ where: { id } });
    if (!device) return reply.code(404).send({ error: "device not found" });
    await prisma.device.delete({ where: { id } }); // interfaces cascade
    await audit({ action: "device.delete", target: device.name, ok: true });
    return { ok: true };
  });

  // Live probe: identify over SNMP, no persistence. The Devices-page TEST.
  app.post("/api/devices/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const device = await prisma.device.findUnique({ where: { id } });
    if (!device) return reply.code(404).send({ error: "device not found" });
    const creds = await credsFor(id);
    if (!creds) return reply.code(500).send({ error: "profile credentials missing" });
    try {
      const identity = await identify(device.address, creds.port, creds.creds);
      await audit({
        action: "device.test",
        target: device.name,
        ok: true,
        output: identity.sysDescr.slice(0, 200),
      });
      // Summary only — full interface rows carry BigInt and belong to IDENTIFY
      const { interfaces, ...sys } = identity;
      return { ok: true, identity: { ...sys, interfaceCount: interfaces.length } };
    } catch (err) {
      await audit({
        action: "device.test",
        target: device.name,
        ok: false,
        output: (err as Error).message,
      });
      return reply.code(502).send({ ok: false, error: (err as Error).message });
    }
  });

  // Identify + persist: sys* fields and the interface table.
  app.post("/api/devices/:id/identify", async (req, reply) => {
    const { id } = req.params as { id: string };
    const device = await prisma.device.findUnique({ where: { id } });
    if (!device) return reply.code(404).send({ error: "device not found" });
    const creds = await credsFor(id);
    if (!creds) return reply.code(500).send({ error: "profile credentials missing" });
    try {
      const identity = await identify(device.address, creds.port, creds.creds);
      const updated = await prisma.device.update({
        where: { id },
        data: {
          sysDescr: identity.sysDescr,
          sysObjectId: identity.sysObjectId,
          sysName: identity.sysName,
          vendor: identity.vendor,
          lastSeenAt: new Date(),
        },
      });
      await prisma.deviceInterface.deleteMany({ where: { deviceId: id } });
      if (identity.interfaces.length > 0) {
        await prisma.deviceInterface.createMany({
          data: identity.interfaces.map((i) => ({ ...i, deviceId: id })),
        });
      }
      await audit({
        action: "device.identify",
        target: device.name,
        ok: true,
        output: `${identity.vendor || "unknown vendor"}, ${identity.interfaces.length} interfaces`,
      });
      return updated;
    } catch (err) {
      await audit({
        action: "device.identify",
        target: device.name,
        ok: false,
        output: (err as Error).message,
      });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
