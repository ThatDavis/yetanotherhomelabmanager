import "./env.js";
import { afterEach, expect, test, vi } from "vitest";
import { buildServer } from "../src/app.js";
import { prisma } from "../src/db.js";
import { execOnHost } from "../src/executor.js";
import { drainQueue, enqueueUpdateJob } from "../src/jobs.js";
import { runNightlyScans } from "../src/scheduler.js";
import { clearTagCache, splitImageRef } from "../src/stacks.js";

vi.mock("../src/executor.js", () => ({
  execOnHost: vi.fn(),
}));

// App-side registry tag lists are stubbed network-wide; per-test
// implementations decide Hub/GHCR responses, default is "not found".
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const execMock = vi.mocked(execOnHost);
const app = buildServer({ spaDir: "/nonexistent", auth: false });

const PREFIX = `test-stack-${Date.now()}`;

const COMPOSE_LS = JSON.stringify([
  { Name: "web", ConfigFiles: "/srv/web/compose.yml" },
  { Name: "db", ConfigFiles: "/srv/db/compose.yml" },
]);

const INSPECT = JSON.stringify([
  {
    Config: {
      Image: "ghcr.io/me/web:1.2.3",
      Labels: {
        "com.docker.compose.project": "web",
        "com.docker.compose.service": "app",
        "com.docker.compose.config-hash": "aaa",
        "org.opencontainers.image.version": "1.2.3",
      },
    },
    RepoDigests: ["ghcr.io/me/web@sha256:abc123"],
    State: { Status: "running" },
  },
  {
    Config: {
      Image: "postgres:16",
      Labels: {
        "com.docker.compose.project": "db",
        "com.docker.compose.service": "pg",
        "com.docker.compose.config-hash": "bbb",
      },
    },
    RepoDigests: ["postgres@sha256:def456"],
    State: { Status: "running" },
  },
  {
    // standalone container — never becomes a stack row
    Config: { Image: "redis:7", Labels: {} },
    State: { Status: "running" },
  },
]);

function scanHandler(opts: { hash?: string | null; remoteDigest?: string } = {}) {
  return (command: string) => {
    if (command === "command -v docker")
      return { ok: true, output: "/usr/bin/docker", exitCode: 0, lines: [] };
    if (command === "docker compose ls --all --format json")
      return { ok: true, output: COMPOSE_LS, exitCode: 0, lines: [] };
    if (command.startsWith("docker compose -p ") && command.includes("config --hash")) {
      if (opts.hash === null) return { ok: false, output: "unknown flag", exitCode: 1, lines: [] };
      const project = /-p '([^']+)'/.exec(command)?.[1] ?? "?";
      // fixture containers carry config-hash labels "aaa" (web) / "bbb" (db)
      return {
        ok: true,
        output: opts.hash ?? (project === "web" ? "aaa" : "bbb"),
        exitCode: 0,
        lines: [],
      };
    }
    if (command.includes("docker inspect"))
      return { ok: true, output: INSPECT, exitCode: 0, lines: [] };
    if (command.includes("buildx imagetools inspect")) {
      const digest =
        opts.remoteDigest ?? (command.includes("ghcr.io/me/web") ? "abc123" : "def456");
      return {
        ok: true,
        output: JSON.stringify({ digest: `sha256:${digest}` }),
        exitCode: 0,
        lines: [],
      };
    }
    if (command.startsWith("for c in apt-get"))
      return { ok: true, output: "/usr/bin/apt-get", exitCode: 0, lines: [] };
    if (command.startsWith("apt-get update"))
      return { ok: true, output: "5\n", exitCode: 0, lines: [] };
    return { ok: true, output: "ok", exitCode: 0, lines: [] };
  };
}

async function makeHost(alias: string) {
  return prisma.host.create({
    data: { alias, hostname: "192.0.2.90", username: "root" },
  });
}

function mockScan(opts: { hash?: string | null; remoteDigest?: string } = {}) {
  const handler = scanHandler(opts);
  execMock.mockImplementation(async (host, command: string) => {
    // runNightlyScans scans every host in the DB — never touch real operator
    // hosts with fixture data; pretend they have no docker.
    if (!(host.alias ?? "").startsWith(PREFIX)) {
      return { ok: false, output: "", exitCode: 1, lines: [] };
    }
    return { ...handler(command), lines: [] };
  });
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 404, json: async () => body } as Response;
}

afterEach(async () => {
  execMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse({}, false)); // registries: default 404
  clearTagCache();
  await prisma.composeStack.deleteMany({ where: { host: { alias: { startsWith: PREFIX } } } });
  await prisma.jobStep.deleteMany({
    where: { job: { schedule: { name: { startsWith: PREFIX } } } },
  });
  await prisma.job.deleteMany({ where: { schedule: { name: { startsWith: PREFIX } } } });
  await prisma.updateSchedule.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.host.deleteMany({ where: { alias: { startsWith: PREFIX } } });
  await prisma.auditEntry.deleteMany({ where: { target: { startsWith: PREFIX } } });
});

test("splitImageRef separates repo and tag, digest-only refs untagged", () => {
  expect(splitImageRef("ghcr.io/me/web:1.2.3")).toEqual({ repo: "ghcr.io/me/web", tag: "1.2.3" });
  expect(splitImageRef("postgres:16")).toEqual({ repo: "postgres", tag: "16" });
  expect(splitImageRef("registry:5000/x/y:latest")).toEqual({
    repo: "registry:5000/x/y",
    tag: "latest",
  });
  expect(splitImageRef("sha256:abc")).toEqual({ repo: "sha256:abc", tag: "" });
});

test("stacks.scan persists projects with services and no drift when hashes match", async () => {
  const host = await makeHost(`${PREFIX}-scan`);
  mockScan();

  const res = await app.inject({ method: "POST", url: `/api/hosts/${host.id}/scan` });
  expect(res.statusCode).toBe(200);
  expect(res.json().stacks.ok).toBe(true);

  const rows = await prisma.composeStack.findMany({
    where: { hostId: host.id },
    orderBy: { project: "asc" },
  });
  expect(rows.map((r) => r.project)).toEqual(["db", "web"]);
  const web = rows.find((r) => r.project === "web");
  expect(web?.drift).toBe(false);
  expect(JSON.parse(web?.services ?? "[]")).toEqual([
    {
      name: "app",
      image: "ghcr.io/me/web:1.2.3",
      tag: "1.2.3",
      digest: "abc123",
      version: "1.2.3",
      state: "running",
      configHash: "aaa",
      updatable: false, // remote digest equals the local one
      latest: null, // registries 404 in tests by default
    },
  ]);
  expect(res.json().os.data.pending).toBe(5);
  const after = await prisma.host.findUniqueOrThrow({ where: { id: host.id } });
  expect(after.osUpdatesPending).toBe(5);
  expect(after.osCheckedAt).not.toBeNull();
});

test("stacks.scan flags drift when a container's config-hash diverges", async () => {
  const host = await makeHost(`${PREFIX}-drift`);
  mockScan({ hash: "different-hash" });

  await app.inject({ method: "POST", url: `/api/hosts/${host.id}/scan` });
  const rows = await prisma.composeStack.findMany({ where: { hostId: host.id } });
  expect(rows.every((r) => r.drift)).toBe(true);
});

test("stacks.scan skips drift detection when the plugin cannot hash config", async () => {
  const host = await makeHost(`${PREFIX}-nohash`);
  mockScan({ hash: null });

  await app.inject({ method: "POST", url: `/api/hosts/${host.id}/scan` });
  const rows = await prisma.composeStack.findMany({ where: { hostId: host.id } });
  expect(rows.every((r) => !r.drift)).toBe(true);
});

test("stacks.scan prunes projects the host no longer reports", async () => {
  const host = await makeHost(`${PREFIX}-prune`);
  await prisma.composeStack.create({
    data: { hostId: host.id, project: "ghost", services: "[]" },
  });
  mockScan();

  await app.inject({ method: "POST", url: `/api/hosts/${host.id}/scan` });
  const rows = await prisma.composeStack.findMany({ where: { hostId: host.id } });
  expect(rows.map((r) => r.project).sort()).toEqual(["db", "web"]);
});

test("stacks.scan skips hosts without docker", async () => {
  const host = await makeHost(`${PREFIX}-nodocker`);
  execMock.mockImplementation(async (_h, command: string) =>
    command === "command -v docker"
      ? { ok: false, output: "", exitCode: 1, lines: [] }
      : { ok: true, output: "ok", exitCode: 0, lines: [] },
  );

  const res = await app.inject({ method: "POST", url: `/api/hosts/${host.id}/scan` });
  expect(res.json().stacks.ok).toBe(true);
  expect(res.json().stacks.output).toContain("docker not installed");
});

test("flags updatable when the remote digest differs from local", async () => {
  const host = await makeHost(`${PREFIX}-upd`);
  mockScan({ remoteDigest: "fff999" });

  const res = await app.inject({ method: "POST", url: `/api/hosts/${host.id}/scan` });
  expect(res.json().stacks.ok).toBe(true);
  expect(res.json().stacks.output).toContain("1 update(s) available");

  const rows = await prisma.composeStack.findMany({ where: { hostId: host.id } });
  for (const row of rows) {
    for (const s of JSON.parse(row.services)) {
      expect(s.updatable).toBe(true);
      expect(s.latest).toBeNull();
    }
  }
});

test("tag lists provide latest versions for pinned tags (GHCR + Hub)", async () => {
  const host = await makeHost(`${PREFIX}-latest`);
  mockScan(); // digests equal — tag lists drive the verdict
  fetchMock.mockImplementation(async (url: string | URL) => {
    const u = String(url);
    if (u === "https://ghcr.io/token?scope=repository:me/web:pull")
      return jsonResponse({ token: "t" });
    if (u === "https://ghcr.io/v2/me/web/tags/list")
      return jsonResponse({ tags: ["1.2.3", "1.3.9", "1.4.0"] });
    if (u.includes("hub.docker.com/v2/repositories/library/postgres/tags"))
      return jsonResponse({ results: [{ name: "16" }, { name: "16.2" }, { name: "latest" }] });
    return jsonResponse({}, false);
  });

  await app.inject({ method: "POST", url: `/api/hosts/${host.id}/scan` });
  const rows = await prisma.composeStack.findMany({ where: { hostId: host.id } });
  const web = JSON.parse(rows.find((r) => r.project === "web")?.services ?? "[]")[0];
  expect(web.updatable).toBe(true);
  expect(web.latest).toBe("1.4.0");
  const db = JSON.parse(rows.find((r) => r.project === "db")?.services ?? "[]")[0];
  expect(db.latest).toBe("16.2");
  expect(db.updatable).toBe(true); // 16 → 16.2 even with equal digests
});

test("registry failures degrade to unknown instead of failing the scan", async () => {
  const host = await makeHost(`${PREFIX}-degrade`);
  execMock.mockImplementation(async (_h, command: string) => {
    if (command === "command -v docker")
      return { ok: true, output: "/usr/bin/docker", exitCode: 0, lines: [] };
    if (command === "docker compose ls --all --format json")
      return { ok: true, output: COMPOSE_LS, exitCode: 0, lines: [] };
    if (command.includes("docker inspect"))
      return { ok: true, output: INSPECT, exitCode: 0, lines: [] };
    return { ok: false, output: "! buildx unavailable", exitCode: 1, lines: [] };
  });
  fetchMock.mockRejectedValue(new Error("network down"));

  const res = await app.inject({ method: "POST", url: `/api/hosts/${host.id}/scan` });
  expect(res.json().stacks.ok).toBe(true);
  const rows = await prisma.composeStack.findMany({ where: { hostId: host.id } });
  for (const row of rows) {
    for (const s of JSON.parse(row.services)) {
      expect(s.updatable).toBeNull();
      expect(s.latest).toBeNull();
    }
  }
});

test("nightly scans run os.check only on hosts in an enabled schedule's scope", async () => {
  const inScope = await makeHost(`${PREFIX}-inscope`);
  const outOfScope = await makeHost(`${PREFIX}-outscope`);
  await prisma.updateSchedule.create({
    data: {
      name: `${PREFIX}-sched`,
      daysOfWeek: [1],
      timeOfDay: "03:00",
      enabled: true,
      hosts: { connect: { id: inScope.id } },
    },
  });
  mockScan();

  await runNightlyScans();

  const a = await prisma.host.findUniqueOrThrow({ where: { id: inScope.id } });
  const b = await prisma.host.findUniqueOrThrow({ where: { id: outOfScope.id } });
  expect(a.osUpdatesPending).toBe(5); // in scope: stacks + os checked
  expect(b.osUpdatesPending).toBe(-1); // stacks scanned, os untouched
  const stacksA = await prisma.composeStack.count({ where: { hostId: inScope.id } });
  const stacksB = await prisma.composeStack.count({ where: { hostId: outOfScope.id } });
  expect(stacksA).toBe(2);
  expect(stacksB).toBe(2);
});

test("stack-scoped container.update only touches listed projects", async () => {
  const host = await makeHost(`${PREFIX}-scoped`);
  mockScan();
  const schedule = await prisma.updateSchedule.create({
    data: {
      name: `${PREFIX}-scoped-sched`,
      daysOfWeek: [1],
      timeOfDay: "03:00",
      osUpdates: false,
      containerUpdates: true,
      containerProjects: JSON.stringify(["web"]),
      verifyUpdates: false,
      hosts: { connect: { id: host.id } },
    },
  });

  const jobId = await enqueueUpdateJob(schedule.id, "manual");
  await drainQueue();

  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    include: { steps: true },
  });
  expect(job.status).toBe("succeeded");
  const step = job.steps.find((s) => s.name === "container.update");
  expect(step?.ok).toBe(true);
  expect(step?.output).toContain("project web: ok");
  expect(step?.output).not.toContain("project db:");
});

test("stacks API lists rows and per-stack update enqueues a stack job", async () => {
  const host = await makeHost(`${PREFIX}-api`);
  await prisma.composeStack.create({
    data: {
      hostId: host.id,
      project: "web",
      configFiles: "/srv/web/compose.yml",
      services: JSON.stringify([]),
    },
  });

  const list = await app.inject({ method: "GET", url: "/api/stacks" });
  expect(list.statusCode).toBe(200);
  const row = list
    .json()
    .find(
      (s: { project: string; host: { alias: string } }) =>
        s.project === "web" && s.host.alias === host.alias,
    );
  expect(row).toBeDefined();

  mockScan();
  const res = await app.inject({ method: "POST", url: `/api/stacks/${row.id}/update` });
  expect(res.statusCode).toBe(202);

  await drainQueue();
  const job = await prisma.job.findUniqueOrThrow({
    where: { id: res.json().jobId },
    include: { steps: true, hosts: true },
  });
  expect(job.kind).toBe("stack");
  expect(job.project).toBe("web");
  expect(job.hosts.map((h) => h.id)).toEqual([host.id]);
  expect(job.steps.find((s) => s.name === "container.update")?.ok).toBe(true);

  const missing = await app.inject({ method: "POST", url: "/api/stacks/nope/update" });
  expect(missing.statusCode).toBe(404);
});
