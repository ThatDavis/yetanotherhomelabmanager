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
