import { useEffect, useState } from "react";
import { NavLink } from "react-router";
import { api, type DashboardData } from "../api";
import { type Status, StatusBadge } from "./StatusBadge";

// Sections grow with milestones (docs/UI.md §1)
const SECTIONS = [
  { to: "/", label: "Dashboard", glyph: "▚", end: true },
  { to: "/uptime", label: "Uptime", glyph: "▲" },
  { to: "/alerts", label: "Alerts", glyph: "⚠" },
  { to: "/nodes", label: "Nodes", glyph: "▦" },
  { to: "/guests", label: "Infra", glyph: "▤" },
  { to: "/updates", label: "Updates", glyph: "↻" },
  { to: "/jobs", label: "Jobs", glyph: "▶" },
  { to: "/audit", label: "Audit", glyph: "≡" },
  { to: "/settings", label: "Settings", glyph: "⚙" },
] as const;

// Worst status across ping targets + nodes, polled (docs/UI.md §1: always visible).
function HealthChip() {
  const [summary, setSummary] = useState<DashboardData["summary"] | null>(null);

  useEffect(() => {
    const load = () =>
      api<DashboardData>("/dashboard")
        .then((d) => setSummary(d.summary))
        .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!summary) return <StatusBadge status="unknown" label="…" />;
  const down = summary.targetsDown;
  const status: Status = down > 0 ? "error" : summary.nodesUp < summary.nodesTotal ? "warn" : "ok";
  const label =
    down > 0
      ? `${down} DOWN`
      : summary.nodesUp < summary.nodesTotal
        ? `${summary.nodesTotal - summary.nodesUp} NODE?`
        : "ALL OK";
  return <StatusBadge status={status} label={label} />;
}

export function Sidebar() {
  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-surface0 bg-mantle">
      <div className="border-b border-surface0 px-4 py-3">
        <div className="phosphor font-mono text-sm font-bold tracking-widest text-accent">
          YAHLM<span className="animate-blink">▮</span>
        </div>
        <div className="micro-label mt-1">YET ANOTHER HLM</div>
      </div>

      <div className="border-b border-surface0 px-4 py-2">
        <HealthChip />
      </div>

      <nav className="flex-1 py-2">
        {SECTIONS.map((s) => (
          <NavLink
            key={s.to}
            to={s.to}
            end={"end" in s && s.end}
            className={({ isActive }) =>
              `flex items-center gap-3 border-l-2 px-4 py-2 font-mono text-sm transition-colors duration-150 ${
                isActive
                  ? "border-accent bg-surface0/50 text-text"
                  : "border-transparent text-subtext0 hover:bg-surface0/30 hover:text-text"
              }`
            }
          >
            <span aria-hidden className="w-4 text-center">
              {s.glyph}
            </span>
            {s.label}
          </NavLink>
        ))}
      </nav>

      <button
        type="button"
        onClick={async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          window.location.href = "/login";
        }}
        className="micro-label block w-full border-t border-surface0 px-4 py-2 text-left transition-colors duration-150 hover:text-status-error"
      >
        ⏻ LOGOUT
      </button>
      <div className="micro-label border-t border-surface0 px-4 py-2">{"SYS.STATUS // M3"}</div>
    </aside>
  );
}
