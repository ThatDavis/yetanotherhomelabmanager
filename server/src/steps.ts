import type { Host } from "@prisma/client";
import { audit } from "./audit.js";
import { execOnHost, type OutputLine } from "./executor.js";

// Step contract (docs/ARCHITECTURE.md §Design Principles).
// Every operation on infrastructure is a step: (ctx, params) → StepResult,
// executed via runStep so the audit entry can never be skipped.

export type StepResult = {
  ok: boolean;
  output: string; // human-readable combined stream
  data?: unknown; // structured JSON for machines — code never parses output
  durationMs: number;
};

/** Run a step with mandatory auditing. Expected failures return ok:false; bugs throw. */
export async function runStep(
  name: string,
  target: string,
  params: Record<string, unknown>,
  fn: () => Promise<Omit<StepResult, "durationMs">>,
): Promise<StepResult> {
  const start = Date.now();
  try {
    const res = await fn();
    const durationMs = Date.now() - start;
    await audit({ action: name, target, params, ok: res.ok, output: res.output, durationMs });
    return { ...res, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    await audit({
      action: name,
      target,
      params,
      ok: false,
      output: `threw: ${(err as Error).message}`,
      durationMs,
    });
    throw err;
  }
}

// health.check — fixed safe probe (no raw exec endpoint; principle 9).
// sh-compatible only: must run on Debian, RHEL, and busybox-ish guests.
const HEALTH_CHECK_CMD = "uname -srm; uptime; df -h /; free -m";

export type HealthCheckData = { lines: OutputLine[]; exitCode: number | null };

export function healthCheck(host: Host): Promise<StepResult> {
  return runStep("health.check", host.alias, {}, async () => {
    const res = await execOnHost(host, HEALTH_CHECK_CMD);
    return { ok: res.ok, output: res.output, data: { lines: res.lines, exitCode: res.exitCode } };
  });
}
