import type { Host, HostService } from "@prisma/client";
import { execOnHost } from "./executor.js";
import { probeServicePort } from "./serviceprobe.js";
import { HEALTH_CHECK_CMD, runStep, type StepResult } from "./steps.js";

// Update steps (M3.1). os.update auto-detects the package manager (apt/dnf/yum);
// container.update rolls Docker Compose projects forward. Neither reboots —
// rebootPending is reported for the job result and M3.2 acts on it.

const OS_UPDATE_TIMEOUT_MS = 30 * 60 * 1000; // apt over VPN can be slow
const CONTAINER_TIMEOUT_MS = 10 * 60 * 1000;

// Probe: print the first available package manager command, nothing else.
export const PM_PROBE = "for c in apt-get dnf yum; do command -v $c && break; done";

// Reboot-pending probe, exit-code shaped: 0 = reboot pending, 1 = not pending.
// Debian/Ubuntu drop /var/run/reboot-required; RHEL family uses needs-restarting
// (when present — absence means "unknown", reported as not pending).
const REBOOT_PROBE =
  "if [ -f /var/run/reboot-required ]; then exit 0; fi; " +
  "if command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r >/dev/null 2>&1 || exit 0; fi; " +
  "exit 1";

export function pmFromProbe(output: string): "apt" | "dnf" | "yum" | null {
  const path = output.trim().split("\n").pop() ?? "";
  if (path.endsWith("apt-get")) return "apt";
  if (path.endsWith("dnf")) return "dnf";
  if (path.endsWith("yum")) return "yum";
  return null;
}

function updateCommand(pm: "apt" | "dnf" | "yum"): string {
  // apt: force conffile prompts to keep the old file so the step can never
  // hang waiting on input; noninteractive covers debconf.
  if (pm === "apt") {
    return (
      "export DEBIAN_FRONTEND=noninteractive; " +
      "apt-get update && apt-get -y -o Dpkg::Options::=--force-confdef " +
      "-o Dpkg::Options::=--force-confold upgrade"
    );
  }
  return pm === "dnf" ? "dnf -y upgrade" : "yum -y update";
}

export type OsUpdateData = { pm: "apt" | "dnf" | "yum" | null; rebootPending: boolean };

// os.update — apply OS package updates. Fails (ok:false) when no supported
// package manager exists; rebootPending is best-effort and never fails the step.
export function osUpdate(host: Host): Promise<StepResult> {
  return runStep("os.update", host.alias, {}, async () => {
    const probe = await execOnHost(host, PM_PROBE);
    const pm = pmFromProbe(probe.output);
    if (!pm) {
      // exitCode null means the probe itself could not run (connection
      // failure) — surface that instead of a misleading PM message.
      const detail = probe.exitCode === null ? `\n${probe.output}` : "";
      return {
        ok: false,
        output: `no supported package manager found (apt-get/dnf/yum)${detail}`,
      };
    }

    const update = await execOnHost(host, updateCommand(pm), OS_UPDATE_TIMEOUT_MS);
    if (!update.ok) {
      return {
        ok: false,
        output: `pm: ${pm}\n${update.output}`,
        data: { pm, rebootPending: false } satisfies OsUpdateData,
      };
    }

    let rebootPending = false;
    const reboot = await execOnHost(host, REBOOT_PROBE);
    if (reboot.exitCode === 0) rebootPending = true;
    else if (reboot.exitCode === null) reboot.output += "\nyahlm: reboot probe unreachable";

    return {
      ok: true,
      output: `pm: ${pm}\n${update.output}\n${reboot.output}`.trim(),
      data: { pm, rebootPending } satisfies OsUpdateData,
    };
  });
}

// --- container.update (Docker Compose projects) ---

type ComposeProject = { Name?: string; ConfigFiles?: string };

function parseComposeProjects(output: string): ComposeProject[] | null {
  try {
    const parsed: unknown = JSON.parse(output.trim());
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (p): p is ComposeProject =>
        p !== null && typeof p === "object" && typeof (p as ComposeProject).Name === "string",
    );
  } catch {
    return null;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// --- host.verify (M3.3) ---

export type VerifyData = {
  healthOk: boolean;
  services: {
    port: number;
    ok: boolean;
    names: string[];
    declared: boolean;
    discovered: boolean;
  }[];
};

type DockerInspectEntry = {
  Name?: string;
  Config?: { Labels?: Record<string, string> };
  NetworkSettings?: { Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> };
};

// Published host ports from `docker inspect` output (structured JSON, so we
// never parse docker's human table). Entries are labeled project/service when
// compose labels are present, else the container name. Only bindings reachable
// off-host are checked — 127.0.0.1-only publishes are invisible to the app.
function extractPublishedPorts(output: string): { name: string; port: number }[] {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];
    const containers = parsed as DockerInspectEntry[]; // docker inspect emits this array shape
    const found: { name: string; port: number }[] = [];
    for (const c of containers) {
      const labels = c.Config?.Labels ?? {};
      const name =
        labels["com.docker.compose.project"] && labels["com.docker.compose.service"]
          ? `${labels["com.docker.compose.project"]}/${labels["com.docker.compose.service"]}`
          : (c.Name ?? "?").replace(/^\//, "");
      const ports = c.NetworkSettings?.Ports ?? {};
      for (const bindings of Object.values(ports)) {
        for (const b of bindings ?? []) {
          if (!b.HostPort) continue;
          if (b.HostIp && b.HostIp !== "0.0.0.0" && b.HostIp !== "::") continue;
          found.push({ name, port: Number(b.HostPort) });
        }
      }
    }
    return found;
  } catch {
    return [];
  }
}

// Discover published container ports; no-ops quietly when docker is absent or
// no containers run (nonzero exit, empty output).
const DISCOVERY_CMD =
  'command -v docker >/dev/null 2>&1 && ids=$(docker ps -q) && [ -n "$ids" ] && docker inspect $ids';

// host.verify — the SSH health probe plus TCP connects from the app to every
// service port: operator-declared services (non-docker coverage) merged with
// docker-published ports discovered at runtime. Runs before and after
// updates; the runner skips a host with a failed pre-check and keeps failed
// post-checks out of the reboot roll.
export function hostVerify(host: Host & { services: HostService[] }): Promise<StepResult> {
  return runStep(
    "host.verify",
    host.alias,
    { services: host.services.map((s) => s.name) },
    async () => {
      const health = await execOnHost(host, HEALTH_CHECK_CMD);
      const lines: string[] = [
        health.ok ? "ssh health: ok" : `ssh health: FAILED\n${health.output}`,
      ];

      const entries: { port: number; name: string; source: "declared" | "discovered" }[] = [
        ...host.services.map((s) => ({ port: s.port, name: s.name, source: "declared" as const })),
      ];
      const dres = await execOnHost(host, DISCOVERY_CMD, 30_000);
      if (dres.ok && dres.output.trim()) {
        for (const d of extractPublishedPorts(dres.output)) {
          entries.push({ port: d.port, name: d.name, source: "discovered" });
        }
      }
      const byPort = new Map<
        number,
        { names: Set<string>; declared: boolean; discovered: boolean }
      >();
      for (const e of entries) {
        const slot = byPort.get(e.port) ?? { names: new Set(), declared: false, discovered: false };
        slot.names.add(e.name);
        slot[e.source] = true;
        byPort.set(e.port, slot);
      }

      const services: VerifyData["services"] = [];
      for (const [port, e] of [...byPort.entries()].sort((a, b) => a[0] - b[0])) {
        const ok = await probeServicePort(host.hostname, port);
        const source = [e.declared ? "declared" : null, e.discovered ? "discovered" : null]
          .filter(Boolean)
          .join("+");
        lines.push(
          `service ${[...e.names].sort().join("/")}:${port} ${ok ? "ok" : "UNREACHABLE"} (${source})`,
        );
        services.push({
          port,
          ok,
          names: [...e.names].sort(),
          declared: e.declared,
          discovered: e.discovered,
        });
      }
      const ok = health.ok && services.every((s) => s.ok);
      return { ok, output: lines.join("\n"), data: { healthOk: health.ok, services } };
    },
  );
}

// --- host.reboot (M3.2) ---

const REBOOT_TIMEOUT_MS = 10 * 60 * 1000; // how long to wait for recovery
const REBOOT_POLL_MS = 5 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RebootData = { recovered: boolean };

// host.reboot — issue a reboot, then poll until SSH + the fixed health probe
// recover. The send itself may drop the connection mid-handshake (expected
// when the host goes down fast), so recovery — not the send — decides ok.
export function hostReboot(
  host: Host,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<StepResult> {
  const timeoutMs = opts.timeoutMs ?? REBOOT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? REBOOT_POLL_MS;
  return runStep("host.reboot", host.alias, {}, async () => {
    const send = await execOnHost(host, "systemctl reboot 2>/dev/null || reboot", 15_000);

    const deadline = Date.now() + timeoutMs;
    let lastProbe = "";
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const probe = await execOnHost(host, HEALTH_CHECK_CMD, 10_000);
      lastProbe = probe.output;
      if (probe.ok) {
        return {
          ok: true,
          output: `reboot issued${send.ok ? "" : ` (send: ${send.output.split("\n").pop()})`}\n${probe.output}`,
          data: { recovered: true } satisfies RebootData,
        };
      }
    }
    return {
      ok: false,
      output: `reboot issued; host did not recover within ${Math.round(timeoutMs / 60000)}min\nlast probe: ${lastProbe}`,
      data: { recovered: false } satisfies RebootData,
    };
  });
}

export type ContainerUpdateData = { projects: { name: string; ok: boolean }[] };

// container.update — `pull && up -d` Docker Compose projects on the host,
// optionally filtered to a project list (M3.6: per-stack scope). Hosts
// without docker or the compose plugin are skipped (ok, with a note) —
// the schedule toggle is the operator's intent per host, and the output shows
// exactly what happened. Standalone containers are never touched.
export function containerUpdate(
  host: Host,
  opts: { projects?: string[] } = {},
): Promise<StepResult> {
  return runStep("container.update", host.alias, { projects: opts.projects ?? [] }, async () => {
    const docker = await execOnHost(host, "command -v docker");
    if (!docker.ok) {
      return {
        ok: true,
        output: "docker not installed — skipped",
        data: { projects: [] },
      };
    }
    const plugin = await execOnHost(host, "docker compose version");
    if (!plugin.ok) {
      return {
        ok: true,
        output: "docker compose plugin not installed — skipped",
        data: { projects: [] },
      };
    }

    const ls = await execOnHost(host, "docker compose ls --all --format json");
    if (!ls.ok) return { ok: false, output: `docker compose ls failed\n${ls.output}` };
    const projects = parseComposeProjects(ls.output);
    if (!projects) return { ok: false, output: "unexpected docker compose ls output (not JSON)" };
    const filter = opts.projects ?? [];
    const named = projects.filter(
      (p): p is typeof p & { Name: string } => typeof p.Name === "string",
    );
    const wanted = filter.length > 0 ? named.filter((p) => filter.includes(p.Name)) : named;
    const missing = filter.filter((name) => !named.some((p) => p.Name === name));
    if (wanted.length === 0 && missing.length === 0) {
      return { ok: true, output: "no compose projects", data: { projects: [] } };
    }

    const results: { name: string; ok: boolean }[] = [];
    const lines: string[] = [];
    for (const name of missing) lines.push(`project ${name}: not found on host — skipped`);
    for (const project of wanted) {
      const name = project.Name as string;
      const files = (project.ConfigFiles ?? "")
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean)
        .map((f) => `-f ${shellQuote(f)}`)
        .join(" ");
      const base = `docker compose -p ${shellQuote(name)} ${files}`.trim();
      const res = await execOnHost(host, `${base} pull && ${base} up -d`, CONTAINER_TIMEOUT_MS);
      results.push({ name, ok: res.ok });
      lines.push(`project ${name}: ${res.ok ? "ok" : "FAILED"}`);
      if (!res.ok) lines.push(res.output);
    }
    lines.push("standalone containers untouched by design");

    return {
      ok: results.every((r) => r.ok),
      output: lines.join("\n"),
      data: { projects: results } satisfies ContainerUpdateData,
    };
  });
}
