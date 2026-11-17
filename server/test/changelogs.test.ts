import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  advisoriesForVersion,
  cachedAdvisoriesForVersion,
  clearGithubCache,
  releaseNotesInRange,
  repoForImage,
} from "../src/changelogs.js";
import { prisma } from "../src/db.js";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("repoForImage (mapping precedence)", () => {
  it("prefers the OCI source label over the curated map", () => {
    expect(
      repoForImage("ghcr.io/immich-app/immich-server:1.1", "https://github.com/custom/fork"),
    ).toBe("custom/fork");
  });

  it("parses git@ URLs and strips .git and trailing paths", () => {
    expect(repoForImage("x/y:1", "git@github.com:navidrome/navidrome.git")).toBe(
      "navidrome/navidrome",
    );
    expect(repoForImage("x/y:1", "https://github.com/getsentry/self-hosted/tree/master")).toBe(
      "getsentry/self-hosted",
    );
  });

  it("falls back to the curated map when no label", () => {
    expect(repoForImage("vaultwarden/server:1.32.0", "")).toBe("dani-garcia/vaultwarden");
  });

  it("returns null when nothing maps (link-out case)", () => {
    expect(repoForImage("lscr.io/linuxserver/sonarr:latest", "")).toBeNull();
  });
});

describe("releaseNotesInRange", () => {
  afterEach(() => {
    clearGithubCache();
    vi.unstubAllGlobals();
  });

  it("filters releases to the current..latest range and flags major bumps", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json([
          { tag_name: "v2.0.0", name: "Two", body: "big changes", html_url: "u2" },
          { tag_name: "v1.3.0", name: "Three", body: "", html_url: "u3" },
          { tag_name: "v1.2.0", name: "Two", body: "", html_url: "u2" },
          { tag_name: "v1.1.0", name: "One", body: "", html_url: "u1" },
        ]),
      ),
    );
    const notes = await releaseNotesInRange("o/r", "v1.2.0", "v2.0.0");
    expect(notes?.map((n) => n.tag)).toEqual(["v2.0.0", "v1.3.0"]);
    expect(notes?.[0]?.majorBump).toBe(true);
    expect(notes?.[1]?.majorBump).toBe(false);
  });

  it("returns [] when current does not parse, null on fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ message: "nope" }, 500)),
    );
    expect(await releaseNotesInRange("o/r", "latest", "2.0.0")).toEqual([]);
    expect(await releaseNotesInRange("o/r", "1.0.0", "2.0.0")).toBeNull();
  });
});

describe("advisoriesForVersion", () => {
  afterEach(() => {
    clearGithubCache();
    vi.unstubAllGlobals();
  });

  const advisories = [
    {
      ghsa_id: "GHSA-1",
      cve_id: "CVE-2026-1",
      severity: "high",
      summary: "bad",
      html_url: "h",
      vulnerabilities: [{ vulnerable_version_range: ">= 1.0.0, < 1.2.0" }],
    },
    {
      ghsa_id: "GHSA-2",
      cve_id: "CVE-2026-2",
      severity: "low",
      summary: "meh",
      html_url: "h2",
      vulnerabilities: [{ vulnerable_version_range: ">= 2.0.0, < 2.5.0" }],
    },
  ];

  it("flags only advisories whose range includes the running version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(advisories)),
    );
    const hits = await advisoriesForVersion("o/r", "1.1.5");
    expect(hits?.map((h) => h.id)).toEqual(["GHSA-1"]);
    expect(hits?.[0]?.cve).toBe("CVE-2026-1");
  });

  it("returns [] for unaffected versions and unparsable versions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(advisories)),
    );
    expect(await advisoriesForVersion("o/r", "1.2.0")).toEqual([]);
    expect(await advisoriesForVersion("o/r", "latest")).toEqual([]);
  });

  it("degrades to null when GitHub fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ message: "rate limited" }, 403)),
    );
    expect(await advisoriesForVersion("o/r", "1.1.5")).toBeNull();
    expect(cachedAdvisoriesForVersion("o/r", "1.1.5")).toBeNull(); // failure not cached
  });

  it("caches: second call reads cache without fetching", async () => {
    const stub = vi.fn(async () => json(advisories));
    vi.stubGlobal("fetch", stub);
    await advisoriesForVersion("o/r", "1.1.5");
    const cached = cachedAdvisoriesForVersion("o/r", "1.1.5");
    expect(cached?.map((h) => h.id)).toEqual(["GHSA-1"]);
    expect(stub).toHaveBeenCalledTimes(1);
  });
});

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  vi.unstubAllGlobals(); // restore global fetch for other suites
  await prisma.$disconnect();
});
