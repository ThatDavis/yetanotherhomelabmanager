import type { Host, Node } from "@prisma/client";
import { audit } from "./audit.js";
import { prisma } from "./db.js";
import { execOnHost, type OutputLine } from "./executor.js";
import { type PveResponse, pveData, pveRequest } from "./proxmox.js";
import { loadSecret } from "./secrets.js";

// Step contract (docs/ARCHITECTURE.md §Design Principles).
// Every operation on infrastructure is a step: (ctx, params) → StepResult,
// executed via runStep so the audit entry can never be skipped.

export type StepResult = {
  ok: boolean;
  output: string; // human-readable combined stream
  data?: unknown; // structured JSON for machines — code never parses output
  durationMs: number;
};

/** Run a step with mandatory auditing. Expected failures return ok:false; bugs throw. */
export async function runStep(
  name: string,
  target: string,
  params: Record<string, unknown>,
  fn: () => Promise<Omit<StepResult, "durationMs">>,
): Promise<StepResult> {
  const start = Date.now();
  try {
    const res = await fn();
    const durationMs = Date.now() - start;
    await audit({ action: name, target, params, ok: res.ok, output: res.output, durationMs });
    return { ...res, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    await audit({
      action: name,
      target,
      params,
      ok: false,
      output: `threw: ${(err as Error).message}`,
      durationMs,
    });
    throw err;
  }
}

// health.check — fixed safe probe (no raw exec endpoint; principle 9).
// sh-compatible only: must run on Debian, RHEL, and busybox-ish guests.
const HEALTH_CHECK_CMD = "uname -srm; uptime; df -h /; free -m";

export type HealthCheckData = { lines: OutputLine[]; exitCode: number | null };

export function healthCheck(host: Host): Promise<StepResult> {
  return runStep("health.check", host.alias, {}, async () => {
    const res = await execOnHost(host, HEALTH_CHECK_CMD);
    return { ok: res.ok, output: res.output, data: { lines: res.lines, exitCode: res.exitCode } };
  });
}

// node.test — connection + privilege probe against a PVE/PBS node.
// First successful connection TOFU-pins the certificate fingerprint; later
// mismatches hard-fail (2026-09-30 decision).
export function nodeTest(node: Node): Promise<StepResult> {
  return runStep("node.test", node.name, { type: node.type }, async () => {
    const lines: string[] = [];

    const secret = await loadSecret(`node-token-${node.id}`);
    if (!secret) return { ok: false, output: "no API token secret stored for this node" };

    let version: PveResponse;
    try {
      version = await pveRequest(node, secret, "/api2/json/version");
    } catch (err) {
      return { ok: false, output: `connection failed: ${(err as Error).message}` };
    }

    if (!node.tlsFingerprint) {
      await prisma.node.update({
        where: { id: node.id },
        data: { tlsFingerprint: version.fingerprint },
      });
      lines.push(`tofu: pinned certificate fingerprint ${version.fingerprint}`);
    } else if (node.tlsFingerprint !== version.fingerprint) {
      lines.push("TLS FINGERPRINT MISMATCH — refusing to trust this server");
      lines.push(`  pinned: ${node.tlsFingerprint}`);
      lines.push(`  peer:   ${version.fingerprint}`);
      lines.push("Possible MITM or reinstalled node. Unpin the fingerprint to re-trust.");
      return { ok: false, output: lines.join("\n") };
    }

    if (version.status === 401) {
      lines.push("authentication failed (401) — check token id and secret");
      return { ok: false, output: lines.join("\n") };
    }
    if (version.status !== 200) {
      lines.push(`version probe failed: HTTP ${version.status}`);
      return { ok: false, output: lines.join("\n") };
    }

    const vd = pveData(version.data);
    const versionStr =
      vd && typeof vd === "object" && "version" in vd ? String(vd.version) : "unknown";
    lines.push(`${node.type} version: ${versionStr}`);

    // Privilege probe: the cheapest listing the token must be able to do.
    const probePath = node.type === "pbs" ? "/api2/json/admin/datastore" : "/api2/json/nodes";
    const probeLabel = node.type === "pbs" ? "list datastores" : "list cluster nodes";
    const probe = await pveRequest(node, secret, probePath);
    if (probe.status === 200) {
      lines.push(`privileges ok: token can ${probeLabel}`);
      return { ok: true, output: lines.join("\n") };
    }
    if (probe.status === 403) {
      lines.push(`INSUFFICIENT PRIVILEGES (403): token cannot ${probeLabel}`);
      lines.push(
        node.type === "pbs" ? "hint: grant Datastore.Audit on /" : "hint: grant PVEAuditor on /",
      );
      return { ok: false, output: lines.join("\n") };
    }
    lines.push(`privilege probe returned HTTP ${probe.status}`);
    return { ok: false, output: lines.join("\n") };
  });
}

// --- Inventory sync (node.sync) ---

type PveGuest = { vmid: number; name: string; status: string; type: string; node: string };

function parseGuests(data: unknown): PveGuest[] {
  if (!Array.isArray(data)) return [];
  const guests: PveGuest[] = [];
  for (const r of data) {
    if (
      r &&
      typeof r === "object" &&
      "vmid" in r &&
      typeof r.vmid === "number" &&
      "name" in r &&
      typeof r.name === "string" &&
      "status" in r &&
      typeof r.status === "string" &&
      "type" in r &&
      typeof r.type === "string" &&
      "node" in r &&
      typeof r.node === "string"
    ) {
      guests.push({ vmid: r.vmid, name: r.name, status: r.status, type: r.type, node: r.node });
    }
  }
  return guests;
}

function countArray(data: unknown): number {
  return Array.isArray(data) ? data.length : 0;
}

function latestBackupTime(data: unknown): number | null {
  if (!Array.isArray(data)) return null;
  let latest: number | null = null;
  for (const r of data) {
    if (r && typeof r === "object" && "backup-time" in r && typeof r["backup-time"] === "number") {
      if (latest === null || r["backup-time"] > latest) latest = r["backup-time"];
    }
  }
  return latest;
}

async function syncPve(node: Node, secret: string): Promise<Omit<StepResult, "durationMs">> {
  const lines: string[] = [];

  const vmRes = await pveRequest(node, secret, "/api2/json/cluster/resources?type=vm");
  if (vmRes.status === 401) return { ok: false, output: "authentication failed (401)" };
  if (vmRes.status === 403) {
    return {
      ok: false,
      output: "INSUFFICIENT PRIVILEGES (403) listing guests — hint: grant PVEAuditor on /",
    };
  }
  if (vmRes.status !== 200)
    return { ok: false, output: `guest listing failed: HTTP ${vmRes.status}` };

  const guests = parseGuests(pveData(vmRes.data));

  // Upsert current guests; prune rows this node no longer reports.
  for (const g of guests) {
    await prisma.guest.upsert({
      where: { nodeDbId_vmid: { nodeDbId: node.id, vmid: g.vmid } },
      update: { pveNode: g.node, type: g.type, name: g.name, status: g.status },
      create: {
        nodeDbId: node.id,
        pveNode: g.node,
        vmid: g.vmid,
        type: g.type,
        name: g.name,
        status: g.status,
      },
    });
  }
  const pruned = await prisma.guest.deleteMany({
    where: { nodeDbId: node.id, vmid: { notIn: guests.map((g) => g.vmid) } },
  });

  const running = guests.filter((g) => g.status === "running").length;
  lines.push(`synced ${guests.length} guests (${running} running)`);
  if (pruned.count > 0) lines.push(`pruned ${pruned.count} stale guest rows`);

  const jobsRes = await pveRequest(node, secret, "/api2/json/cluster/backup");
  if (jobsRes.status === 200) {
    const jobs = pveData(jobsRes.data);
    const enabled = Array.isArray(jobs)
      ? jobs.filter((j) => j && typeof j === "object" && "enabled" in j && j.enabled === 1).length
      : 0;
    lines.push(`${countArray(jobs)} backup jobs (${enabled} enabled)`);
  } else {
    lines.push(`backup job listing failed: HTTP ${jobsRes.status}`);
  }

  const storageRes = await pveRequest(node, secret, "/api2/json/cluster/resources?type=storage");
  if (storageRes.status === 200) {
    lines.push(`${countArray(pveData(storageRes.data))} storage pools`);
  } else {
    lines.push(`storage listing failed: HTTP ${storageRes.status}`);
  }

  return {
    ok: true,
    output: lines.join("\n"),
    data: { guests: guests.length, running, pruned: pruned.count },
  };
}

async function syncPbs(node: Node, secret: string): Promise<Omit<StepResult, "durationMs">> {
  const lines: string[] = [];

  const dsRes = await pveRequest(node, secret, "/api2/json/admin/datastore");
  if (dsRes.status === 401) return { ok: false, output: "authentication failed (401)" };
  if (dsRes.status === 403) {
    return {
      ok: false,
      output: "INSUFFICIENT PRIVILEGES (403) listing datastores — hint: grant Datastore.Audit on /",
    };
  }
  if (dsRes.status !== 200)
    return { ok: false, output: `datastore listing failed: HTTP ${dsRes.status}` };

  const stores: string[] = [];
  const raw = pveData(dsRes.data);
  if (Array.isArray(raw)) {
    for (const r of raw) {
      if (r && typeof r === "object" && "store" in r && typeof r.store === "string") {
        stores.push(r.store);
      }
    }
  }

  const summaries: { store: string; snapshots: number; latestBackup: number | null }[] = [];
  for (const store of stores) {
    const snapRes = await pveRequest(node, secret, `/api2/json/admin/datastore/${store}/snapshots`);
    if (snapRes.status !== 200) {
      lines.push(`${store}: snapshot listing failed (HTTP ${snapRes.status})`);
      continue;
    }
    const snaps = pveData(snapRes.data);
    const summary = { store, snapshots: countArray(snaps), latestBackup: latestBackupTime(snaps) };
    summaries.push(summary);
    const latest = summary.latestBackup
      ? new Date(summary.latestBackup * 1000).toISOString()
      : "never";
    lines.push(`${store}: ${summary.snapshots} snapshots, latest ${latest}`);
  }

  return { ok: true, output: lines.join("\n") || "no datastores", data: { datastores: summaries } };
}

// node.sync — pull inventory from a PVE/PBS node. PVE guests are persisted
// (upsert + prune); PBS datastore summaries are returned live.
export function nodeSync(node: Node): Promise<StepResult> {
  return runStep("node.sync", node.name, { type: node.type }, async () => {
    const secret = await loadSecret(`node-token-${node.id}`);
    if (!secret) return { ok: false, output: "no API token secret stored for this node" };
    try {
      return node.type === "pbs" ? await syncPbs(node, secret) : await syncPve(node, secret);
    } catch (err) {
      return { ok: false, output: `connection failed: ${(err as Error).message}` };
    }
  });
}
