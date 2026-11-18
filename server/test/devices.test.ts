import "./env.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { prisma } from "../src/db.js";
import {
  type Session,
  setSessionFactoryForTest,
  type Varbind,
  vendorFromSysObjectId,
} from "../src/snmp.js";

const app = buildServer({ spaDir: "/nonexistent", auth: false });
const PREFIX = "test-dev-";

// A canned Ubiquiti switch: 2 interfaces, one up one down.
const SYS: Varbind[] = [
  { oid: "1.3.6.1.2.1.1.1.0", type: 4, value: Buffer.from("USW-Flex 6.6.55") },
  { oid: "1.3.6.1.2.1.1.2.0", type: 6, value: "1.3.6.1.4.1.41112.1.6" },
  { oid: "1.3.6.1.2.1.1.3.0", type: 67, value: 123456 },
  { oid: "1.3.6.1.2.1.1.5.0", type: 4, value: Buffer.from("garage-sw") },
];
const IF_TABLE: Varbind[] = [
  { oid: "1.3.6.1.2.1.2.2.1.2.1", type: 4, value: Buffer.from("eth0") },
  { oid: "1.3.6.1.2.1.2.2.1.2.2", type: 4, value: Buffer.from("eth1") },
  {
    oid: "1.3.6.1.2.1.2.2.1.6.1",
    type: 4,
    value: Buffer.from([0x70, 0xa7, 0x41, 0x11, 0x22, 0x33]),
  },
  { oid: "1.3.6.1.2.1.2.2.1.8.1", type: 2, value: 1 },
  { oid: "1.3.6.1.2.1.2.2.1.8.2", type: 2, value: 2 },
];
const IF_XTABLE: Varbind[] = [
  { oid: "1.3.6.1.2.1.31.1.1.1.1.1", type: 4, value: Buffer.from("port1") },
  { oid: "1.3.6.1.2.1.31.1.1.1.1.2", type: 4, value: Buffer.from("port2") },
  { oid: "1.3.6.1.2.1.31.1.1.1.15.1", type: 2, value: 1000 },
  { oid: "1.3.6.1.2.1.31.1.1.1.18.1", type: 4, value: Buffer.from("uplink") },
];

function fakeSession(opts?: { fail?: boolean }): Session {
  return {
    get: (_oids, cb) => (opts?.fail ? cb(new Error("Request timed out")) : cb(null, SYS)),
    subtree: (_oid, cb) => {
      if (opts?.fail) return cb(new Error("Request timed out"));
      // ifTable subtree starts with ifDescr (2.x), ifXTable with ifName (1.x)
      cb(
        null,
        _oid.includes("31.1.1.1") && !_oid.startsWith("1.3.6.1.2.1.2") ? IF_XTABLE : IF_TABLE,
      );
    },
    close: () => {},
  };
}

async function makeDevice(): Promise<{ profileId: string; deviceId: string }> {
  const p = await app.inject({
    method: "POST",
    url: "/api/snmp-profiles",
    payload: {
      name: `${PREFIX}profile-${Date.now()}`,
      version: "v2c",
      creds: { version: "v2c", community: "notpublic" },
    },
  });
  const profileId = p.json().id as string;
  const d = await app.inject({
    method: "POST",
    url: "/api/devices",
    payload: { name: `${PREFIX}sw-${Date.now()}`, address: "192.0.2.99", profileId },
  });
  return { profileId, deviceId: d.json().id as string };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterEach(async () => {
  setSessionFactoryForTest(null);
  await prisma.deviceInterface.deleteMany({ where: { device: { name: { startsWith: PREFIX } } } });
  await prisma.device.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.snmpProfile.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.secret.deleteMany({ where: { id: { startsWith: "snmp-profile-" } } });
  await prisma.auditEntry.deleteMany({
    where: { action: { startsWith: "device." }, target: { startsWith: PREFIX } },
  });
  await prisma.auditEntry.deleteMany({ where: { action: { startsWith: "snmpProfile." } } });
});

describe("vendor inference", () => {
  it("maps enterprise prefixes", () => {
    expect(vendorFromSysObjectId("1.3.6.1.4.1.41112.1.6")).toBe("ubiquiti");
    expect(vendorFromSysObjectId("1.3.6.1.4.1.9.1.516")).toBe("cisco");
    expect(vendorFromSysObjectId("1.3.6.1.4.1.14988.1")).toBe("mikrotik");
    expect(vendorFromSysObjectId("1.3.6.1.4.1.99999.1")).toBe("");
    expect(vendorFromSysObjectId("")).toBe("");
  });
});

describe("devices API", () => {
  it("creates a profile with creds in the Secret store, never in the row", async () => {
    const { profileId } = await makeDevice();
    const profile = await prisma.snmpProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(profile.version).toBe("v2c");
    expect(JSON.stringify(profile)).not.toContain("notpublic");
    const secret = await prisma.secret.findUnique({ where: { id: profile.secretRef } });
    expect(secret).not.toBeNull();
    // list shows metadata only
    const list = await app.inject({ method: "GET", url: "/api/snmp-profiles" });
    const row = list.json().find((p: { id: string }) => p.id === profileId);
    expect(row._count.devices).toBe(1);
    expect(JSON.stringify(row)).not.toContain("notpublic");
  });

  it("test probes live SNMP and audits the result", async () => {
    const { deviceId } = await makeDevice();
    setSessionFactoryForTest(() => fakeSession());
    const res = await app.inject({ method: "POST", url: `/api/devices/${deviceId}/test` });
    expect(res.statusCode).toBe(200);
    expect(res.json().identity.sysName).toBe("garage-sw");
    const auditRow = await prisma.auditEntry.findFirst({
      where: { action: "device.test" },
      orderBy: { at: "desc" },
    });
    expect(auditRow?.ok).toBe(true);
  });

  it("test failure returns 502 and audits the failure", async () => {
    const { deviceId } = await makeDevice();
    setSessionFactoryForTest(() => fakeSession({ fail: true }));
    const res = await app.inject({ method: "POST", url: `/api/devices/${deviceId}/test` });
    expect(res.statusCode).toBe(502);
    const auditRow = await prisma.auditEntry.findFirst({
      where: { action: "device.test" },
      orderBy: { at: "desc" },
    });
    expect(auditRow?.ok).toBe(false);
  });

  it("identify persists sys fields, vendor, and interfaces", async () => {
    const { deviceId } = await makeDevice();
    setSessionFactoryForTest(() => fakeSession());
    const res = await app.inject({ method: "POST", url: `/api/devices/${deviceId}/identify` });
    expect(res.statusCode).toBe(200);
    expect(res.json().vendor).toBe("ubiquiti");
    expect(res.json().sysName).toBe("garage-sw");

    const detail = await app.inject({ method: "GET", url: `/api/devices/${deviceId}` });
    const body = detail.json();
    expect(body.interfaces).toHaveLength(2);
    const p1 = body.interfaces.find((i: { name: string }) => i.name === "port1");
    expect(p1.alias).toBe("uplink");
    expect(p1.speedBps).toBe("1000000000");
    expect(p1.mac).toBe("70:a7:41:11:22:33");
    expect(p1.operStatus).toBe("up");
    const p2 = body.interfaces.find((i: { name: string }) => i.name === "port2");
    expect(p2.operStatus).toBe("down");
  });

  it("blocks deleting a profile in use", async () => {
    const { profileId } = await makeDevice();
    const res = await app.inject({ method: "DELETE", url: `/api/snmp-profiles/${profileId}` });
    expect(res.statusCode).toBe(409);
  });
});
