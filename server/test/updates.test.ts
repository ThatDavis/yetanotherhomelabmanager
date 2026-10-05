import "./env.js";
import type { Host } from "@prisma/client";
import { afterEach, expect, test, vi } from "vitest";
import { prisma } from "../src/db.js";
import { execOnHost } from "../src/executor.js";
import { probeServicePort } from "../src/serviceprobe.js";
import {
  containerUpdate,
  hostReboot,
  hostVerify,
  osUpdate,
  type VerifyData,
} from "../src/updates.js";

vi.mock("../src/executor.js", () => ({
  execOnHost: vi.fn(),
}));

vi.mock("../src/serviceprobe.js", () => ({
  probeServicePort: vi.fn(),
}));

const execMock = vi.mocked(execOnHost);
const probeMock = vi.mocked(probeServicePort);

const host: Host = {
  id: "h1",
  alias: "test-updates-1",
  hostname: "192.0.2.20",
  port: 22,
  username: "root",
  notes: "",
  self: false,
  bootOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function mockExec(
  handler: (command: string) => { ok: boolean; output: string; exitCode: number | null },
) {
  execMock.mockImplementation(async (_host, command: string) => {
    const r = handler(command);
    return { ...r, lines: [] };
  });
}

function osHandler(
  overrides: { pm?: string; updateOk?: boolean; rebootExit?: number | null } = {},
) {
  const { pm = "/usr/bin/apt-get", updateOk = true, rebootExit = 1 } = overrides;
  return (command: string) => {
    if (command.startsWith("if [ -f /var/run/reboot-required")) {
      return { ok: rebootExit === 0, output: "", exitCode: rebootExit };
    }
    if (command.includes("command -v")) {
      return { ok: pm !== "", output: pm, exitCode: pm ? 0 : 1 };
    }
    return {
      ok: updateOk,
      output: updateOk ? "all packages up to date" : "! E: dpkg interrupted",
      exitCode: updateOk ? 0 : 100,
    };
  };
}

afterEach(async () => {
  execMock.mockReset();
  probeMock.mockReset();
  await prisma.auditEntry.deleteMany({ where: { target: { startsWith: "test-updates-" } } });
});

test("os.update on apt host succeeds and reports no reboot pending", async () => {
  mockExec(osHandler());
  const res = await osUpdate(host);
  expect(res.ok).toBe(true);
  expect(res.data).toEqual({ pm: "apt", rebootPending: false });
  // probe, upgrade, reboot probe — no raw update command without detection
  expect(execMock).toHaveBeenCalledTimes(3);
  expect(execMock.mock.calls[1][1]).toContain("apt-get update");
});

test("os.update detects dnf and reports reboot pending", async () => {
  mockExec(osHandler({ pm: "/usr/bin/dnf", rebootExit: 0 }));
  const res = await osUpdate(host);
  expect(res.ok).toBe(true);
  expect(res.data).toEqual({ pm: "dnf", rebootPending: true });
  expect(execMock.mock.calls[1][1]).toBe("dnf -y upgrade");
});

test("os.update fails loudly with no package manager", async () => {
  mockExec(osHandler({ pm: "" }));
  const res = await osUpdate(host);
  expect(res.ok).toBe(false);
  expect(res.output).toContain("no supported package manager");
  expect(execMock).toHaveBeenCalledTimes(1); // never runs an update command
});

test("os.update surfaces connection failure from the probe", async () => {
  mockExec(() => ({ ok: false, output: "! yahlm: connection failed: timed out", exitCode: null }));
  const res = await osUpdate(host);
  expect(res.ok).toBe(false);
  expect(res.output).toContain("no supported package manager");
  expect(res.output).toContain("connection failed"); // not just the PM message
});

test("os.update failure keeps pm and skips reboot probe", async () => {
  mockExec(osHandler({ updateOk: false }));
  const res = await osUpdate(host);
  expect(res.ok).toBe(false);
  expect(res.data).toEqual({ pm: "apt", rebootPending: false });
  expect(execMock).toHaveBeenCalledTimes(2);
});

test("os.update is audited", async () => {
  mockExec(osHandler());
  await osUpdate(host);
  const row = await prisma.auditEntry.findFirst({
    where: { action: "os.update", target: host.alias },
  });
  expect(row).not.toBeNull();
  expect(row?.ok).toBe(true);
});

const COMPOSE_LS = JSON.stringify([
  { Name: "web", ConfigFiles: "/srv/web/compose.yml" },
  { Name: "db", ConfigFiles: "/srv/db/compose.yml,/srv/db/compose.prod.yml" },
]);

function dockerHandler(overrides: { pullOk?: Record<string, boolean> } = {}) {
  const pullOk = overrides.pullOk ?? {};
  return (command: string) => {
    if (command === "command -v docker")
      return { ok: true, output: "/usr/bin/docker", exitCode: 0 };
    if (command === "docker compose version") return { ok: true, output: "2.27", exitCode: 0 };
    if (command === "docker compose ls --all --format json")
      return { ok: true, output: COMPOSE_LS, exitCode: 0 };
    if (command.startsWith("docker compose -p ")) {
      const name = /-p '([^']+)'/.exec(command)?.[1] ?? "?";
      const ok = pullOk[name] ?? true;
      return { ok, output: ok ? "pulled" : "! pull failed", exitCode: ok ? 0 : 1 };
    }
    return { ok: false, output: `unexpected: ${command}`, exitCode: 1 };
  };
}

test("container.update pulls and re-creates every compose project", async () => {
  mockExec(dockerHandler());
  const res = await containerUpdate(host);
  expect(res.ok).toBe(true);
  expect(res.data).toEqual({
    projects: [
      { name: "web", ok: true },
      { name: "db", ok: true },
    ],
  });
  const dbCall = execMock.mock.calls.find((c) => c[1].startsWith("docker compose -p 'db'"));
  expect(dbCall?.[1]).toContain("-f '/srv/db/compose.yml' -f '/srv/db/compose.prod.yml'");
  expect(dbCall?.[1]).toContain("pull && ");
  expect(res.output).toContain("standalone containers untouched");
});

test("container.update continues after a project failure and reports ok:false", async () => {
  mockExec(dockerHandler({ pullOk: { web: false } }));
  const res = await containerUpdate(host);
  expect(res.ok).toBe(false);
  expect(res.data).toEqual({
    projects: [
      { name: "web", ok: false },
      { name: "db", ok: true },
    ],
  });
});

test("container.update skips gracefully without docker or compose plugin", async () => {
  mockExec((command) => {
    if (command === "command -v docker") return { ok: false, output: "", exitCode: 1 };
    return { ok: false, output: "", exitCode: 1 };
  });
  const noDocker = await containerUpdate(host);
  expect(noDocker.ok).toBe(true);
  expect(noDocker.output).toContain("docker not installed");

  mockExec((command) => {
    if (command === "command -v docker")
      return { ok: true, output: "/usr/bin/docker", exitCode: 0 };
    return { ok: false, output: "", exitCode: 1 };
  });
  const noPlugin = await containerUpdate(host);
  expect(noPlugin.ok).toBe(true);
  expect(noPlugin.output).toContain("compose plugin not installed");
});

test("container.update fails on non-JSON compose ls output", async () => {
  mockExec((command) => {
    if (command === "command -v docker")
      return { ok: true, output: "/usr/bin/docker", exitCode: 0 };
    if (command === "docker compose version") return { ok: true, output: "2.27", exitCode: 0 };
    return { ok: true, output: "garbage", exitCode: 0 };
  });
  const res = await containerUpdate(host);
  expect(res.ok).toBe(false);
  expect(res.output).toContain("not JSON");
});

// --- host.verify (M3.3) ---

const SERVICES = [
  { id: "s1", hostId: "h1", name: "web", port: 8080 },
  { id: "s2", hostId: "h1", name: "db", port: 5432 },
];

test("host.verify passes when health and all services are reachable", async () => {
  mockExec(() => ({ ok: true, output: "Linux 6.8 up", exitCode: 0 }));
  probeMock.mockResolvedValue(true);
  const res = await hostVerify({ ...host, services: SERVICES });
  expect(res.ok).toBe(true);
  expect(res.data).toEqual({
    healthOk: true,
    services: [
      { name: "web", port: 8080, ok: true },
      { name: "db", port: 5432, ok: true },
    ],
  });
  expect(res.output).toContain("service web:8080 ok");
});

test("host.verify fails when a service port is unreachable", async () => {
  mockExec(() => ({ ok: true, output: "Linux 6.8 up", exitCode: 0 }));
  probeMock.mockImplementation(async (_h, port) => port !== 5432);
  const res = await hostVerify({ ...host, services: SERVICES });
  expect(res.ok).toBe(false);
  expect(res.output).toContain("service db:5432 UNREACHABLE");
});

test("host.verify fails on bad SSH health even with services up", async () => {
  mockExec(() => ({ ok: false, output: "! connection refused", exitCode: null }));
  probeMock.mockResolvedValue(true);
  const res = await hostVerify({ ...host, services: SERVICES });
  expect(res.ok).toBe(false);
  const data = res.data as VerifyData; // StepResult.data is unknown by contract
  expect(data.healthOk).toBe(false);
});

test("host.verify is audited", async () => {
  mockExec(() => ({ ok: true, output: "up", exitCode: 0 }));
  probeMock.mockResolvedValue(true);
  await hostVerify({ ...host, services: [] });
  const row = await prisma.auditEntry.findFirst({
    where: { action: "host.verify", target: host.alias },
  });
  expect(row?.ok).toBe(true);
});

// --- host.reboot (M3.2) ---

const REBOOT_CMD = "systemctl reboot";

test("host.reboot recovers after transient downtime", async () => {
  let polls = 0;
  mockExec((command: string) => {
    if (command === REBOOT_CMD)
      return { ok: false, output: "! connection dropped", exitCode: null };
    polls += 1; // health probe
    return polls < 3
      ? { ok: false, output: "! connection refused", exitCode: null }
      : { ok: true, output: "Linux 6.8 up", exitCode: 0 };
  });
  const res = await hostReboot(host, { pollMs: 1, timeoutMs: 5000 });
  expect(res.ok).toBe(true);
  expect(res.data).toEqual({ recovered: true });
  expect(polls).toBe(3); // kept polling through the outage
});

test("host.reboot fails when the host never comes back", async () => {
  mockExec((command: string) => {
    if (command === REBOOT_CMD) return { ok: true, output: "", exitCode: 0 };
    return { ok: false, output: "! connection refused", exitCode: null };
  });
  const res = await hostReboot(host, { pollMs: 1, timeoutMs: 100 });
  expect(res.ok).toBe(false);
  expect(res.data).toEqual({ recovered: false });
  expect(res.output).toContain("did not recover");
});

test("host.reboot is audited", async () => {
  mockExec((command: string) =>
    command === REBOOT_CMD
      ? { ok: true, output: "", exitCode: 0 }
      : { ok: true, output: "up", exitCode: 0 },
  );
  await hostReboot(host, { pollMs: 1, timeoutMs: 5000 });
  const row = await prisma.auditEntry.findFirst({
    where: { action: "host.reboot", target: host.alias },
  });
  expect(row?.ok).toBe(true);
});
