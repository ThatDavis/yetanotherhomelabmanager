import { execFile } from "node:child_process";

// Ping executor: shells out to the system ping binary (busybox- and
// iputils-compatible flags). One probe, bounded by -W timeout.

export type PingResult = { ok: boolean; latencyMs: number | null; error: string };

export function ping(host: string, timeoutSec = 2): Promise<PingResult> {
  const { promise, resolve } = Promise.withResolvers<PingResult>();
  execFile("ping", ["-c", "1", "-W", String(timeoutSec), host], (err, stdout, stderr) => {
    if (!err) {
      const match = /time=([\d.]+)\s*ms/.exec(stdout);
      resolve({ ok: true, latencyMs: match?.[1] ? Math.round(Number(match[1])) : null, error: "" });
      return;
    }
    const detail = (stderr || stdout).trim().split("\n").pop() ?? "ping failed";
    resolve({ ok: false, latencyMs: null, error: detail });
  });
  return promise;
}
