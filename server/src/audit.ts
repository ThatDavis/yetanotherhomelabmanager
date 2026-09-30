import { prisma } from "./db.js";

// Append-only audit writer. One row per step execution or mutating API action.
// The M1 "audit log" feature builds the viewer + broader coverage on top of this.

export type AuditRecord = {
  action: string; // dotted name, e.g. host.register, health.check
  target?: string;
  params?: Record<string, unknown>; // secrets must be redacted by the caller
  ok: boolean;
  output?: string;
  durationMs?: number;
};

export async function audit(rec: AuditRecord): Promise<void> {
  await prisma.auditEntry.create({
    data: {
      actor: "operator", // single-operator until auth lands
      action: rec.action,
      target: rec.target ?? "",
      params: JSON.stringify(rec.params ?? {}),
      ok: rec.ok,
      output: rec.output ?? "",
      durationMs: rec.durationMs ?? 0,
    },
  });
}
