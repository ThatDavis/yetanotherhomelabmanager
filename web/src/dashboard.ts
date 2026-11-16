import { useEffect, useState } from "react";
import { api, type DashboardData } from "./api";

// Single shared /api/dashboard poller — the Dashboard page and the sidebar
// HealthChip subscribe here instead of running independent timers. Polling
// runs only while at least one subscriber is mounted; last-good data is
// kept across transient errors.
const POLL_MS = 30_000;

type DashState = { data: DashboardData | null; error: string | null };
type IntervalHandle = number; // DOM setInterval handle

let state: DashState = { data: null, error: null };
const listeners = new Set<() => void>();
let timer: IntervalHandle | null = null;

async function poll() {
  try {
    state = { data: await api<DashboardData>("/dashboard"), error: null };
  } catch (err) {
    state = { data: state.data, error: (err as Error).message };
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useDashboard(): DashState {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => subscribe(() => setSnapshot({ ...state })), []);
  return snapshot;
}
