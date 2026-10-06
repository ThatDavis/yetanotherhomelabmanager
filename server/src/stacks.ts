import type { Host } from "@prisma/client";
import { prisma } from "./db.js";
import { execOnHost } from "./executor.js";
import { runStep, type StepResult } from "./steps.js";
import { PM_PROBE, pmFromProbe } from "./updates.js";

// Compose stack inventory (M3.6). stacks.scan discovers what runs on each
// docker host and caches it in ComposeStack rows so overview surfaces never
// block on SSH. Registry/update-available checks (sub-task 3) extend the
// service entries stored here.

export type StackService = {
  name: string;
  image: string; // full ref as referenced in compose, e.g. ghcr.io/x/y:2.3
  tag: string; // "" when untagged (digest-only refs)
  digest: string; // local image digest, "" when unknown
  version: string; // OCI version label, "" when absent
  state: string; // running, exited, ...
  configHash: string; // compose config-hash label, "" when absent
  updatable: boolean | null; // null = not checked (registry pass fills this)
  latest: string | null; // best-effort from registry tag lists (sub-task 3)
};

type ComposeProject = { Name?: string; ConfigFiles?: string };

const COMPOSE_LS = "docker compose ls --all --format json";
// All containers (running or not) so drift and stopped stacks are visible.
const INSPECT_ALL =
  'command -v docker >/dev/null 2>&1 && ids=$(docker ps -aq) && [ -n "$ids" ] && docker inspect $ids';

function parseComposeProjects(output: string): ComposeProject[] {
  try {
    const parsed: unknown = JSON.parse(output.trim());
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is ComposeProject =>
        p !== null && typeof p === "object" && typeof (p as ComposeProject).Name === "string",
    );
  } catch {
    return [];
  }
}

type InspectEntry = {
  Config?: {
    Image?: string;
    Labels?: Record<string, string>;
  };
  Image?: string; // local image id (sha256:...)
  RepoDigests?: string[];
  State?: { Status?: string };
};

function parseInspect(output: string): InspectEntry[] {
  try {
    const parsed: unknown = JSON.parse(output.trim());
    return Array.isArray(parsed) ? (parsed as InspectEntry[]) : [];
  } catch {
    return [];
  }
}

/** Split an image ref into repository and tag: "ghcr.io/x/y:2.3" → ["ghcr.io/x/y", "2.3"]. */
export function splitImageRef(ref: string): { repo: string; tag: string } {
  if (ref.startsWith("sha256:")) return { repo: ref, tag: "" };
  const at = ref.indexOf("@");
  if (at !== -1) return { repo: ref.slice(0, at), tag: "" };
  const lastSlash = ref.lastIndexOf("/");
  const lastColon = ref.lastIndexOf(":");
  if (lastColon > lastSlash) {
    return { repo: ref.slice(0, lastColon), tag: ref.slice(lastColon + 1) };
  }
  return { repo: ref, tag: "" };
}

function serviceFromContainer(c: InspectEntry): StackService | null {
  const labels = c.Config?.Labels ?? {};
  const service = labels["com.docker.compose.service"];
  if (!service) return null; // standalone container — not part of a stack
  const image = c.Config?.Image ?? "?";
  const { tag } = splitImageRef(image);
  const digest =
    (c.RepoDigests ?? [])
      .find((d) => d.includes("@"))
      ?.split("@")[1]
      ?.replace(/^sha256:/, "") ?? "";
  return {
    name: service,
    image,
    tag,
    digest,
    version: labels["org.opencontainers.image.version"] ?? labels["org.label-schema.version"] ?? "",
    state: c.State?.Status ?? "unknown",
    configHash: labels["com.docker.compose.config-hash"] ?? "",
    updatable: null,
    latest: null,
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Current config hash for a project; empty string when the compose plugin
// cannot compute one (older plugins) — drift detection skips those projects.
async function projectConfigHash(host: Host, project: ComposeProject): Promise<string | null> {
  const files = (project.ConfigFiles ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => `-f ${shellQuote(f)}`)
    .join(" ");
  const base = `docker compose -p ${shellQuote(project.Name ?? "")} ${files}`.trim();
  const res = await execOnHost(host, `${base} config --hash`, 30_000);
  if (!res.ok || !res.output.trim()) return null;
  return res.output.trim().split("\n").pop()?.trim() ?? null;
}

// stacks.scan — refresh one host's ComposeStack rows. Hosts without docker
// are skipped quietly (ok), same pattern as container.update.
export function stacksScan(host: Host): Promise<StepResult> {
  return runStep("stacks.scan", host.alias, {}, async () => {
    const docker = await execOnHost(host, "command -v docker");
    if (!docker.ok) {
      return { ok: true, output: "docker not installed — skipped", data: { projects: 0 } };
    }

    const ls = await execOnHost(host, COMPOSE_LS);
    if (!ls.ok) return { ok: false, output: `docker compose ls failed\n${ls.output}` };
    const projects = parseComposeProjects(ls.output);
    if (projects.length === 0) {
      await prisma.composeStack.deleteMany({ where: { hostId: host.id } });
      return { ok: true, output: "no compose projects", data: { projects: 0 } };
    }

    const inspectRes = await execOnHost(host, INSPECT_ALL, 60_000);
    if (!inspectRes.ok) return { ok: false, output: `docker inspect failed\n${inspectRes.output}` };
    const containers = parseInspect(inspectRes.output);
    const byProject = new Map<string, StackService[]>();
    for (const c of containers) {
      const labels = c.Config?.Labels ?? {};
      const project = labels["com.docker.compose.project"];
      if (!project) continue;
      const svc = serviceFromContainer(c);
      if (!svc) continue;
      const list = byProject.get(project) ?? [];
      list.push(svc);
      byProject.set(project, list);
    }

    const lines: string[] = [];
    let driftCount = 0;
    for (const p of projects) {
      const name = p.Name as string;
      const services = (byProject.get(name) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      const hash = await projectConfigHash(host, p);
      const drift =
        hash !== null && services.some((s) => s.configHash !== "" && s.configHash !== hash);
      if (drift) driftCount += 1;
      await prisma.composeStack.upsert({
        where: { hostId_project: { hostId: host.id, project: name } },
        update: {
          configFiles: p.ConfigFiles ?? "",
          services: JSON.stringify(services),
          drift,
          scannedAt: new Date(),
        },
        create: {
          hostId: host.id,
          project: name,
          configFiles: p.ConfigFiles ?? "",
          services: JSON.stringify(services),
          drift,
        },
      });
      lines.push(
        `${name}: ${services.length} service(s)${drift ? " DRIFT" : ""}${
          services.some((s) => s.state !== "running") ? " (some not running)" : ""
        }`,
      );
    }
    // Prune stacks this host no longer reports.
    await prisma.composeStack.deleteMany({
      where: { hostId: host.id, project: { notIn: projects.map((p) => p.Name as string) } },
    });

    return {
      ok: true,
      output: lines.join("\n"),
      data: { projects: projects.length, drift: driftCount },
    };
  });
}

// os.check — how many package upgrades are pending, cached on the Host row
// for the dashboard's hosts-needing-updates card.
export function osCheck(host: Host): Promise<StepResult> {
  return runStep("os.check", host.alias, {}, async () => {
    const probe = await execOnHost(host, PM_PROBE);
    const pm = pmFromProbe(probe.output);
    if (!pm) {
      await persistOsCount(host.id, -1);
      return { ok: false, output: "no supported package manager found (apt-get/dnf/yum)" };
    }
    const cmd =
      pm === "apt"
        ? "apt-get update -qq >/dev/null 2>&1; apt list --upgradable 2>/dev/null | wc -l"
        : "dnf check-update 2>/dev/null | grep -v -e '^[[:space:]]*$' -e '^Obsoleting' | grep -c ' ' || true";
    const res = await execOnHost(host, cmd, 5 * 60 * 1000);
    const pending = res.ok ? Number.parseInt(res.output.trim(), 10) || 0 : -1;
    await persistOsCount(host.id, pending);
    return {
      ok: res.ok,
      output: res.ok ? `${pending} package(s) upgradable (pm: ${pm})` : res.output,
      data: { pm, pending },
    };
  });
}

async function persistOsCount(hostId: string, pending: number): Promise<void> {
  try {
    await prisma.host.update({
      where: { id: hostId },
      data: { osUpdatesPending: pending, osCheckedAt: new Date() },
    });
  } catch {
    // host deleted mid-check
  }
}
