export type Host = {
  id: string;
  alias: string;
  hostname: string;
  port: number;
  username: string;
  notes: string;
  self: boolean;
  bootOrder: number;
  services: { id: string; name: string; port: number }[];
  osUpdatesPending: number; // -1 unknown (M3.6)
  osCheckedAt: string | null;
  createdAt: string;
};

export type OutputLine = { stream: "stdout" | "stderr"; line: string };

export type ProbeResult = {
  ok: boolean;
  output: string;
  durationMs: number;
  data?: { lines: OutputLine[]; exitCode: number | null };
};

export type Node = {
  id: string;
  name: string;
  type: "pve" | "pbs";
  url: string;
  tokenId: string;
  tlsFingerprint: string;
};

export type Guest = {
  id: string;
  vmid: number;
  type: string;
  name: string;
  status: string;
  pveNode: string;
  nodeName: string;
};

export type SyncResult = {
  ok: boolean;
  results: { node: string; ok: boolean; output: string }[];
};

export type HostRegisterResult = { host: Host; existing: boolean };

export type AgentIpsData = { guests: { vmid: number; name: string; addresses: string[] }[] };

export type StackService = {
  name: string;
  image: string;
  tag: string;
  digest: string;
  version: string;
  state: string;
  updatable: boolean | null;
  latest: string | null;
};

export type ComposeStack = {
  id: string;
  project: string;
  configFiles: string;
  services: StackService[];
  drift: boolean;
  scannedAt: string;
  host: { id: string; alias: string };
};

export type AuditEntry = {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  params: string;
  ok: boolean;
  output: string;
  durationMs: number;
};

export type AuditPage = { entries: AuditEntry[]; nextBefore: string | null };

export type Webhook = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: string;
};

export type ChannelResult = { channel: string; ok: boolean; error?: string };

export type AlertsConfig = {
  emailEnabled: boolean;
  smtpConfigured: boolean;
  webhooks: Webhook[];
};

export type PingTarget = {
  id: string;
  name: string;
  host: string;
  intervalSec: number;
  alertAfter: number;
  enabled: boolean;
  status: "unknown" | "up" | "down";
  consecutiveFailures: number;
  lastLatencyMs: number | null;
  lastCheckedAt: string | null;
  notify: boolean;
  notifyEmail: boolean;
  webhooks: Webhook[];
};

export type UpdateSchedule = {
  id: string;
  name: string;
  daysOfWeek: number[]; // 0=Sunday .. 6=Saturday
  timeOfDay: string; // "HH:MM"
  osUpdates: boolean;
  containerUpdates: boolean;
  containerProjects: string[]; // [] = all compose projects on scoped hosts
  rebootAfterUpdate: boolean;
  verifyUpdates: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  hosts: { id: string; alias: string; hostname: string; self: boolean }[];
  jobs: { id: string; status: string; startedAt: string }[];
};

export type JobStep = {
  id: string;
  name: string; // dotted step name
  phase: string; // pre | post for host.verify; "" otherwise
  ok: boolean;
  output: string;
  rebootPending: boolean;
  startedAt: string;
  finishedAt: string | null; // null while the step is running
  durationMs: number;
  host: { id: string; alias: string; self: boolean } | null;
};

export type Job = {
  id: string;
  trigger: "scheduled" | "manual" | "auto";
  kind: "update" | "reboot" | "stack";
  project: string; // stack jobs: the compose project
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  schedule: { id: string; name: string } | null;
  steps: JobStep[];
};

export type DashboardData = {
  targets: (PingTarget & { results: { ok: boolean; at: string; latencyMs: number | null }[] })[];
  nodes: { id: string; name: string; type: string; status: string; lastCheckedAt: string | null }[];
  guests: { running: number; stopped: number; other: number };
  recentAudit: AuditEntry[];
  summary: {
    targetsUp: number;
    targetsDown: number;
    targetsTotal: number;
    nodesUp: number;
    nodesTotal: number;
    stacksTotal: number;
    stacksUpdatable: number;
    stacksDrift: number;
    hostsNeedingUpdates: number;
  };
  hosts: { id: string; alias: string; osUpdatesPending: number; osCheckedAt: string | null }[];
  stacks: { total: number; updatable: number; drift: number };
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    // Fastify 400s on content-type: application/json with an empty body
    ...(init?.body ? { headers: { "content-type": "application/json" } } : {}),
    ...init,
  });
  if (res.status === 401 && !window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      throw new Error(body.error);
    }
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}
