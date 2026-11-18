import snmp from "net-snmp";

// NOC.1: SNMP client wrapper. All network access goes through openSession so
// tests can substitute a fake (same pattern as the executor/SSH seam).
// net-snmp notes: v3 DES privacy breaks on Node ≥17 OpenSSL 3 — profiles
// should use AES. Sessions are short-lived: one per identify/test call.

export type SnmpCreds =
  | { version: "v2c"; community: string }
  | {
      version: "v3";
      user: string;
      authProto: "md5" | "sha" | "sha256" | "sha512";
      authKey: string;
      privProto: "aes" | "aes256";
      privKey: string;
    };

export type Session = {
  get: (oids: string[], cb: (err: Error | null, varbinds?: Varbind[]) => void) => void;
  subtree: (oid: string, cb: (err: Error | null, varbinds?: Varbind[]) => void) => void;
  close: () => void;
};
export type Varbind = { oid: string; type: number; value: unknown };

// Test seam: null restores the real net-snmp sessions.
let sessionFactory: ((address: string, port: number, creds: SnmpCreds) => Session) | null = null;
export function setSessionFactoryForTest(f: typeof sessionFactory): void {
  sessionFactory = f;
}

function openSession(address: string, port: number, creds: SnmpCreds): Session {
  if (sessionFactory) return sessionFactory(address, port, creds);
  const opts = { port, timeout: 5000, retries: 1 };
  const raw =
    creds.version === "v2c"
      ? snmp.createSession(address, creds.community, opts)
      : snmp.createV3Session(
          address,
          {
            name: creds.user,
            level: snmp.SecurityLevel.authPriv,
            authProtocol: {
              md5: snmp.AuthProtocols.md5,
              sha: snmp.AuthProtocols.sha,
              sha256: snmp.AuthProtocols.sha256,
              sha512: snmp.AuthProtocols.sha512,
            }[creds.authProto],
            authKey: creds.authKey,
            privProtocol: { aes: snmp.PrivProtocols.aes, aes256: snmp.PrivProtocols.aes256r }[
              creds.privProto
            ],
            privKey: creds.privKey,
          },
          opts,
        );
  // Adapt net-snmp's feed/done-callback subtree to a single-completion shape.
  return {
    get: (oids, cb) => {
      raw.get(oids, (err, varbinds) => cb(err, (varbinds ?? []) as Varbind[]));
    },
    subtree: (oid, cb) => {
      const acc: Varbind[] = [];
      raw.subtree(
        oid,
        (vbs) => acc.push(...(vbs as Varbind[])),
        (err) => cb(err, acc),
      );
    },
    close: () => raw.close(),
  };
}

function get(session: Session, oids: string[]): Promise<Varbind[]> {
  const { promise, resolve, reject } = Promise.withResolvers<Varbind[]>();
  session.get(oids, (err, varbinds) => (err ? reject(err) : resolve(varbinds ?? [])));
  return promise;
}

function subtree(session: Session, oid: string): Promise<Varbind[]> {
  const { promise, resolve, reject } = Promise.withResolvers<Varbind[]>();
  session.subtree(oid, (err, varbinds) => (err ? reject(err) : resolve(varbinds ?? [])));
  return promise;
}

const valueText = (v: Varbind | undefined): string => {
  if (!v || v.value === undefined || v.value === null) return "";
  if (Buffer.isBuffer(v.value)) return v.value.toString();
  return String(v.value);
};

const valueMac = (v: Varbind | undefined): string => {
  if (!v || !Buffer.isBuffer(v.value) || v.value.length !== 6) return "";
  return [...v.value].map((b) => b.toString(16).padStart(2, "0")).join(":");
};

// IANA private enterprise numbers for the stated targets + common homelab
// vendors. sysObjectID = 1.3.6.1.4.1.<enterprise>...
const ENTERPRISE_VENDOR: Record<string, string> = {
  "9": "cisco",
  "2636": "juniper",
  "4526": "netgear",
  "6574": "synology",
  "8072": "net-snmp (linux/bsd)", // OPNsense/pfSense report via net-snmpd
  "11863": "tp-link",
  "12325": "freebsd",
  "14988": "mikrotik",
  "41112": "ubiquiti",
};

export function vendorFromSysObjectId(sysObjectId: string): string {
  const m = /^1\.3\.6\.1\.4\.1\.(\d+)/.exec(sysObjectId);
  return (m?.[1] && ENTERPRISE_VENDOR[m[1]]) || "";
}

export type IfaceInfo = {
  ifIndex: number;
  name: string;
  descr: string;
  alias: string;
  speedBps: bigint;
  mac: string;
  operStatus: string;
};

export type DeviceIdentity = {
  sysDescr: string;
  sysObjectId: string;
  sysName: string;
  sysUpTime: string;
  vendor: string;
  interfaces: IfaceInfo[];
};

const OID = {
  sysDescr: "1.3.6.1.2.1.1.1.0",
  sysObjectId: "1.3.6.1.2.1.1.2.0",
  sysUpTime: "1.3.6.1.2.1.1.3.0",
  sysName: "1.3.6.1.2.1.1.5.0",
  ifTable: "1.3.6.1.2.1.2.2.1",
  ifXTable: "1.3.6.1.2.1.31.1.1.1",
} as const;

const OPER_STATUS: Record<string, string> = {
  "1": "up",
  "2": "down",
  "3": "testing",
  "4": "unknown",
  "5": "dormant",
  "6": "notPresent",
  "7": "lowerLayerDown",
};

/** sys* OIDs + interface tables, one session. Throws on timeout/unreachable. */
export async function identify(
  address: string,
  port: number,
  creds: SnmpCreds,
): Promise<DeviceIdentity> {
  const session = openSession(address, port, creds);
  try {
    const sysVbs = await get(session, [OID.sysDescr, OID.sysObjectId, OID.sysUpTime, OID.sysName]);
    const byOid = new Map(sysVbs.map((v) => [v.oid, v]));
    const sysObjectId = valueText(byOid.get(OID.sysObjectId));

    // Interface tables are best-effort: a device that answers system but not
    // interfaces is still identified (subtree failures degrade to []).
    const ifEntries = new Map<number, IfaceInfo>();
    const ensure = (idx: number): IfaceInfo => {
      let e = ifEntries.get(idx);
      if (!e) {
        e = { ifIndex: idx, name: "", descr: "", alias: "", speedBps: 0n, mac: "", operStatus: "" };
        ifEntries.set(idx, e);
      }
      return e;
    };
    try {
      for (const v of await subtree(session, OID.ifTable)) {
        const suffix = v.oid.slice(OID.ifTable.length + 1);
        const dot = suffix.indexOf(".");
        if (dot < 0) continue;
        const col = suffix.slice(0, dot);
        const idx = Number(suffix.slice(dot + 1));
        if (!Number.isInteger(idx)) continue;
        const e = ensure(idx);
        if (col === "2")
          e.descr = valueText(v); // ifDescr
        else if (col === "5" && e.speedBps === 0n)
          e.speedBps = BigInt(valueText(v) || "0"); // ifSpeed
        else if (col === "6")
          e.mac = valueMac(v); // ifPhysAddress
        else if (col === "8") e.operStatus = OPER_STATUS[valueText(v)] ?? valueText(v); // ifOperStatus
      }
    } catch {
      // no ifTable — rare, degrade
    }
    try {
      for (const v of await subtree(session, OID.ifXTable)) {
        const suffix = v.oid.slice(OID.ifXTable.length + 1);
        const dot = suffix.indexOf(".");
        if (dot < 0) continue;
        const col = suffix.slice(0, dot);
        const idx = Number(suffix.slice(dot + 1));
        if (!Number.isInteger(idx)) continue;
        const e = ensure(idx);
        if (col === "1")
          e.name = valueText(v); // ifName
        else if (col === "15")
          e.speedBps = BigInt(valueText(v) || "0") * 1_000_000n; // ifHighSpeed (Mbps)
        else if (col === "18") e.alias = valueText(v); // ifAlias
      }
    } catch {
      // v1-only or locked-down agents may lack ifXTable — degrade
    }
    for (const e of ifEntries.values()) if (!e.name) e.name = e.descr;

    return {
      sysDescr: valueText(byOid.get(OID.sysDescr)),
      sysObjectId,
      sysName: valueText(byOid.get(OID.sysName)),
      sysUpTime: valueText(byOid.get(OID.sysUpTime)),
      vendor: vendorFromSysObjectId(sysObjectId),
      interfaces: [...ifEntries.values()].sort((a, b) => a.ifIndex - b.ifIndex),
    };
  } finally {
    session.close();
  }
}
