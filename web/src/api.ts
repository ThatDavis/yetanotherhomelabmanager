export type Host = {
  id: string;
  alias: string;
  hostname: string;
  port: number;
  username: string;
  notes: string;
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
