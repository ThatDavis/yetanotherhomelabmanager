import type { Host } from "@prisma/client";
import { prisma } from "./db.js";
import { execOnHost } from "./executor.js";
import { runStep, type StepResult } from "./steps.js";
import { PM_PROBE, pmFromProbe } from "./updates.js";

// --- Update-available detection ---

// Remote digest for an image ref, resolved ON the host so its registry logins
// apply (private registries work with zero secrets stored here). Multi-arch
// manifests resolve to the index digest, which is what RepoDigests records.
const REMOTE_DIGEST_TIMEOUT_MS = 30_000;

async function remoteDigest(host: Host, ref: string): Promise<string | null> {
  const res = await execOnHost(
    host,
    `docker buildx imagetools inspect ${shellQuote(ref)} --format '{{json .Manifest}}'`,
    REMOTE_DIGEST_TIMEOUT_MS,
  );
  if (!res.ok) return null;
  try {
    const manifest: unknown = JSON.parse(res.output.trim().split("\n").pop() ?? "");
    if (manifest && typeof manifest === "object" && "digest" in manifest) {
      const d = (manifest as { digest?: unknown }).digest;
      return typeof d === "string" ? d.replace(/^sha256:/, "") : null;
    }
    return null;
  } catch {
    return null;
  }
}

const VERSION_PREFIX = /^(v?\d+(?:\.\d+){0,2})/;

function versionKey(tag: string): number[] | null {
  const m = VERSION_PREFIX.exec(tag);
  const key = m?.[1];
  if (!key) return null;
  return key
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10));
}

function versionGreater(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// App-side tag lists for pinned-tag version numbers. Best-effort by design:
// failures degrade to digest-only "update available" signals. Hub anonymous
// API is rate-limited (100 req/6h per IP) — the 6h cache keeps nightly scans
// well inside that at homelab scale.
const TAG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const tagCache = new Map<string, { tags: string[]; at: number }>();

/** Test hook: reset the tag-list cache between tests. */
export function clearTagCache(): void {
  tagCache.clear();
}

function hubRepoName(repo: string): string | null {
  if (repo.includes(".") && repo.includes("/")) return null; // third-party registry — not Hub
  if (repo.includes("/")) return repo; // ns/name
  return `library/${repo}`; // single name is the official library
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
}

async function registryTags(repo: string): Promise<string[] | null> {
  const cached = tagCache.get(repo);
  if (cached && Date.now() - cached.at < TAG_CACHE_TTL_MS) return cached.tags;
  let tags: string[] | null = null;
  try {
    if (repo.startsWith("ghcr.io/")) {
      const name = repo.slice("ghcr.io/".length);
      const tokenRes = await fetchWithTimeout(
        `https://ghcr.io/token?scope=repository:${name}:pull`,
      );
      const token = tokenRes.ok ? ((await tokenRes.json()) as { token?: string }).token : null;
      if (!token) throw new Error("ghcr token denied");
      const res = await fetchWithTimeout(`https://ghcr.io/v2/${name}/tags/list`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok) tags = ((await res.json()) as { tags?: string[] }).tags ?? [];
    } else {
      const name = hubRepoName(repo);
      if (!name) return null; // unknown registry — no app-side tag list
      const res = await fetchWithTimeout(
        `https://hub.docker.com/v2/repositories/${name}/tags?page_size=100`,
      );
      if (res.ok) {
        const body = (await res.json()) as { results?: { name?: string }[] };
        tags = (body.results ?? []).map((t) => t.name ?? "").filter(Boolean);
      }
    }
  } catch {
    tags = null; // best-effort: network/registry failures degrade quietly
  }
  if (tags) tagCache.set(repo, { tags, at: Date.now() });
  return tags;
}

/** Best-effort newest version tag for a repo, given the current tag shape. */
async function latestVersion(repo: string, currentTag: string): Promise<string | null> {
  const currentKey = versionKey(currentTag);
  if (!currentKey) return null; // "latest" and friends: digest compare speaks
  const tags = await registryTags(repo);
  if (!tags) return null;
  let best: { tag: string; key: number[] } | null = null;
  for (const tag of tags) {
    const key = versionKey(tag);
    if (!key) continue;
    if (!best || versionGreater(key, best.key)) best = { tag, key };
  }
  return best?.tag ?? null;
}

type RegistryInfo = { updatable: boolean | null; latest: string | null };

// Decide updatable/latest for one image ref. Digest compare is authoritative
// when both digests are known; the tag list only adds version NUMBERS for
// pinned tags. Anything missing → null fields, never a failure.
async function checkImageUpdate(
  host: Host,
  ref: string,
  localDigest: string,
): Promise<RegistryInfo> {
  const { repo, tag } = splitImageRef(ref);
  const [remote, latest] = await Promise.all([
    remoteDigest(host, ref),
    tag ? latestVersion(repo, tag) : Promise.resolve(null),
  ]);
  let updatable: boolean | null = null;
  if (remote && localDigest) updatable = remote !== localDigest;
  if (latest && tag) {
    const cur = versionKey(tag);
    const nxt = versionKey(latest);
    if (cur && nxt && versionGreater(nxt, cur)) {
      updatable = true; // registry tag list shows something newer
    } else if (updatable === null) {
      updatable = false; // registry sees nothing newer and digests unknown
    }
  }
  return { updatable, latest };
}

// Compose stack inventory (M3.6). stacks.scan discovers what runs on each
// docker host and caches it in ComposeStack rows so overview surfaces never
// block on SSH. Update-available detection: on-host digest compares (the
// host's own registry creds cover private registries; YAHLM stores no
// registry secrets) plus best-effort Docker Hub/GHCR tag lists for pinned
// tags, app-side with an in-process cache.

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

    // Update-available pass, once per unique image across all projects.
    // Failures degrade to null fields — they never fail the scan.
    const refs = new Map<string, string>(); // image ref → local digest
    for (const services of byProject.values()) {
      for (const s of services) refs.set(s.image, s.digest);
    }
    const registry = new Map<string, RegistryInfo>();
    for (const [ref, digest] of refs) {
      registry.set(ref, await checkImageUpdate(host, ref, digest));
    }
    for (const services of byProject.values()) {
      for (const s of services) {
        const r = registry.get(s.image);
        s.updatable = r?.updatable ?? null;
        s.latest = r?.latest ?? null;
      }
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
      const pending = services.filter((s) => s.updatable === true).length;
      lines.push(
        `${name}: ${services.length} service(s)${drift ? " DRIFT" : ""}${
          pending > 0 ? `, ${pending} update(s) available` : ""
        }${services.some((s) => s.state !== "running") ? " (some not running)" : ""}`,
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
