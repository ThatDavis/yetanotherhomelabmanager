import { audit } from "./audit.js";
import { loadSecret } from "./secrets.js";
import { versionGreater, versionKey } from "./stacks.js";

// M3.7: changelogs + CVE surface for compose images that map to a GitHub
// repo. Mapping precedence: OCI source label (captured at scan) → curated
// built-in map → null (caller links out). All GitHub calls are best-effort:
// cached 6h, audited, and every failure degrades to null — a GitHub outage
// must never block an update flow. CVE data is APP-LEVEL only (the project's
// own advisories), never an OS-layer scan — the UI says so.

// Curated fallback for popular homelab images whose OCI source label is
// absent or points somewhere useless. Key: image repository (no tag).
const CURATED_REPOS: Record<string, string> = {
  "vaultwarden/server": "dani-garcia/vaultwarden",
  "ghcr.io/navidrome/navidrome": "navidrome/navidrome",
  "ghcr.io/gethomepage/homepage": "gethomepage/homepage",
  "ghcr.io/immich-app/immich-server": "immich-app/immich",
  "ghcr.io/paperless-ngx/paperless-ngx": "paperless-ngx/paperless-ngx",
};

/** Resolve an image to a GitHub "owner/repo", or null when unmapped. */
export function repoForImage(image: string, sourceLabel: string): string | null {
  const fromLabel = parseGithubUrl(sourceLabel);
  if (fromLabel) return fromLabel;
  const repo = image.split(":")[0]?.split("@")[0];
  return repo ? (CURATED_REPOS[repo] ?? null) : null;
}

function parseGithubUrl(url: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+)/.exec(url);
  const owner = m?.[1];
  const name = m?.[2];
  if (!owner || !name) return null;
  return `${owner}/${name.replace(/\.git$/, "")}`;
}

// ---------------------------------------------------------------- GitHub API

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; data: unknown }>();

/** Test seam: wipe the response cache between tests. */
export function clearGithubCache(): void {
  cache.clear();
}

async function githubFetch(path: string): Promise<unknown | null> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const started = Date.now();
  let ok = false;
  let detail = "";
  try {
    const token = await loadSecret("github-token");
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2026-03-10",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    ok = res.ok;
    detail = `HTTP ${res.status}`;
    if (!res.ok) return null; // 404 (no advisories), 403 (rate limit) — all degrade
    const data: unknown = await res.json();
    cache.set(path, { at: Date.now(), data });
    return data;
  } catch (err) {
    detail = (err as Error).message;
    return null;
  } finally {
    await audit({
      action: "github.fetch",
      target: path,
      ok,
      output: detail,
      durationMs: Date.now() - started,
    }).catch(() => {});
  }
}

// ------------------------------------------------------------- release notes

export type ReleaseNote = {
  tag: string;
  name: string;
  body: string; // markdown, truncated
  url: string;
  majorBump: boolean; // first digit differs from the running version
};

/**
 * Release notes for the range (current..latest]. Null when GitHub is
 * unreachable/rate-limited; [] when the range has no published releases.
 */
export async function releaseNotesInRange(
  repo: string,
  currentVersion: string,
  latestVersion: string,
): Promise<ReleaseNote[] | null> {
  const current = versionKey(currentVersion);
  const latest = versionKey(latestVersion);
  if (!current || !latest) return [];
  const data = await githubFetch(`/repos/${repo}/releases?per_page=30`);
  if (!Array.isArray(data)) return null;
  const notes: ReleaseNote[] = [];
  for (const r of data) {
    const rel = r as { tag_name?: string; name?: string; body?: string; html_url?: string };
    const key = versionKey(rel.tag_name ?? "");
    if (!key || !versionGreater(key, current) || versionGreater(key, latest)) continue;
    notes.push({
      tag: rel.tag_name ?? "",
      name: rel.name ?? rel.tag_name ?? "",
      body: (rel.body ?? "").slice(0, 4000),
      url: rel.html_url ?? "",
      majorBump: key[0] !== current[0],
    });
  }
  return notes.sort((a, b) =>
    versionGreater(versionKey(a.tag) ?? [], versionKey(b.tag) ?? []) ? -1 : 1,
  );
}

// ------------------------------------------------------------ CVE advisories

export type Advisory = {
  id: string; // GHSA id
  cve: string; // CVE id or ""
  severity: string;
  summary: string;
  url: string;
};

/** True when `version` satisfies a GHSA range like ">= 1.0.0, < 1.2.3". */
export function versionInRange(version: string, range: string): boolean {
  const key = versionKey(version);
  if (!key) return false;
  for (const part of range.split(",")) {
    const m = /^\s*(>=|<=|>|<|=)?\s*(\S+)\s*$/.exec(part);
    const raw = m?.[2];
    if (!raw) return false; // unparsable comparator → don't guess
    const op = m?.[1] ?? "=";
    const rhs = versionKey(raw);
    if (!rhs) return false;
    const gt = versionGreater(key, rhs);
    const lt = versionGreater(rhs, key);
    const eq = !gt && !lt;
    if (op === ">=" && !gt && !eq) return false;
    if (op === "<=" && !lt && !eq) return false;
    if (op === ">" && !gt) return false;
    if (op === "<" && !lt) return false;
    if (op === "=" && !eq) return false;
  }
  return true;
}

/**
 * App-level advisories affecting `runningVersion` in `repo`. Null on any
 * fetch failure (degrade to no badge); [] when none apply.
 */
export async function advisoriesForVersion(
  repo: string,
  runningVersion: string,
): Promise<Advisory[] | null> {
  if (!versionKey(runningVersion)) return [];
  const data = await githubFetch(`/repos/${repo}/security-advisories?per_page=100`);
  if (!Array.isArray(data)) return null;
  return filterAdvisories(data, runningVersion);
}

function filterAdvisories(data: unknown[], runningVersion: string): Advisory[] {
  const hits: Advisory[] = [];
  for (const a of data) {
    const adv = a as {
      ghsa_id?: string;
      cve_id?: string | null;
      severity?: string;
      summary?: string;
      html_url?: string;
      vulnerabilities?: { vulnerable_version_range?: string }[];
    };
    const affected = (adv.vulnerabilities ?? []).some(
      (v) =>
        v.vulnerable_version_range && versionInRange(runningVersion, v.vulnerable_version_range),
    );
    if (affected) {
      hits.push({
        id: adv.ghsa_id ?? "",
        cve: adv.cve_id ?? "",
        severity: adv.severity ?? "unknown",
        summary: adv.summary ?? "",
        url: adv.html_url ?? "",
      });
    }
  }
  return hits;
}

// List views must never block on GitHub (M3.6 invariant) — they read the
// cache synchronously and kick a background warm for cold repos.
const warming = new Set<string>();

/** Cache-only read: null when cold (caller shows no badge). */
export function cachedAdvisoriesForVersion(
  repo: string,
  runningVersion: string,
): Advisory[] | null {
  if (!versionKey(runningVersion)) return [];
  const hit = cache.get(`/repos/${repo}/security-advisories?per_page=100`);
  if (!hit || Date.now() - hit.at >= CACHE_TTL_MS) return null;
  return Array.isArray(hit.data) ? filterAdvisories(hit.data, runningVersion) : null;
}

/** Fire-and-forget: warm the advisory cache for repos not already cached. */
export function warmAdvisoryCache(repos: string[]): void {
  for (const repo of repos) {
    const path = `/repos/${repo}/security-advisories?per_page=100`;
    const hit = cache.get(path);
    if ((hit && Date.now() - hit.at < CACHE_TTL_MS) || warming.has(repo)) continue;
    warming.add(repo);
    void advisoriesForVersion(repo, "0.0.0") // fetch only; filter result discarded
      .finally(() => warming.delete(repo));
  }
}
