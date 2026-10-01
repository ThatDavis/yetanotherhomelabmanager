import type { Host } from "@prisma/client";
import { execOnHost } from "./executor.js";
import { runStep, type StepResult } from "./steps.js";

// Update steps (M3.1). os.update auto-detects the package manager (apt/dnf/yum);
// container.update rolls Docker Compose projects forward. Neither reboots —
// rebootPending is reported for the job result and M3.2 acts on it.

const OS_UPDATE_TIMEOUT_MS = 30 * 60 * 1000; // apt over VPN can be slow
const CONTAINER_TIMEOUT_MS = 10 * 60 * 1000;

// Probe: print the first available package manager command, nothing else.
const PM_PROBE = "for c in apt-get dnf yum; do command -v $c && break; done";

// Reboot-pending probe, exit-code shaped: 0 = reboot pending, 1 = not pending.
// Debian/Ubuntu drop /var/run/reboot-required; RHEL family uses needs-restarting
// (when present — absence means "unknown", reported as not pending).
const REBOOT_PROBE =
  "if [ -f /var/run/reboot-required ]; then exit 0; fi; " +
  "if command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r >/dev/null 2>&1 || exit 0; fi; " +
  "exit 1";

function pmFromProbe(output: string): "apt" | "dnf" | "yum" | null {
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
      return { ok: false, output: "no supported package manager found (apt-get/dnf/yum)" };
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

export type ContainerUpdateData = { projects: { name: string; ok: boolean }[] };

// container.update — `pull && up -d` every Docker Compose project on the host.
// Hosts without docker or the compose plugin are skipped (ok, with a note) —
// the schedule toggle is the operator's intent per host, and the output shows
// exactly what happened. Standalone containers are never touched.
export function containerUpdate(host: Host): Promise<StepResult> {
  return runStep("container.update", host.alias, {}, async () => {
    const docker = await execOnHost(host, "command -v docker");
    if (!docker.ok) {
      return { ok: true, output: "docker not installed — skipped", data: { projects: [] } };
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
    if (projects.length === 0) {
      return { ok: true, output: "no compose projects", data: { projects: [] } };
    }

    const results: { name: string; ok: boolean }[] = [];
    const lines: string[] = [];
    for (const project of projects) {
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
