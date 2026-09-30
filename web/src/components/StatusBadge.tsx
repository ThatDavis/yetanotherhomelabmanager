export type Status = "ok" | "warn" | "error" | "unknown" | "running";

const CONFIG: Record<Status, { icon: string; label: string; className: string }> = {
  ok: { icon: "✓", label: "OK", className: "text-status-ok border-status-ok/40" },
  warn: { icon: "▲", label: "WARN", className: "text-status-warn border-status-warn/40" },
  error: { icon: "✕", label: "ERROR", className: "text-status-error border-status-error/40" },
  unknown: {
    icon: "◌",
    label: "UNKNOWN",
    className: "text-status-unknown border-status-unknown/40",
  },
  running: {
    icon: "▶",
    label: "RUNNING",
    className: "text-status-running border-status-running/40 animate-pulse",
  },
};

export function StatusBadge({ status, label }: { status: Status; label?: string }) {
  const cfg = CONFIG[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 border bg-transparent px-2 py-0.5 font-mono text-[11px] uppercase tracking-widest ${cfg.className}`}
    >
      <span aria-hidden>{cfg.icon}</span>
      <span>{label ?? cfg.label}</span>
    </span>
  );
}
