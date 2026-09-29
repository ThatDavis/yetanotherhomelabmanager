import { NavLink } from "react-router";
import { StatusBadge } from "./StatusBadge";

// Sections grow with milestones (docs/UI.md §1)
const SECTIONS = [
  { to: "/", label: "Dashboard", glyph: "▚", end: true },
  { to: "/nodes", label: "Nodes", glyph: "▦" },
  { to: "/guests", label: "Guests", glyph: "▤" },
  { to: "/jobs", label: "Jobs", glyph: "▶" },
  { to: "/audit", label: "Audit", glyph: "≡" },
  { to: "/settings", label: "Settings", glyph: "⚙" },
] as const;

export function Sidebar() {
  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-surface0 bg-mantle">
      <div className="border-b border-surface0 px-4 py-3">
        <div className="phosphor font-mono text-sm font-bold tracking-widest text-accent">
          HLM<span className="animate-blink">▮</span>
        </div>
        <div className="micro-label mt-1">HOME LAB MANAGER</div>
      </div>

      <div className="border-b border-surface0 px-4 py-2">
        {/* Placeholder until Nodes feature lands — will summarize worst node status */}
        <StatusBadge status="unknown" label="0 NODES" />
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

      <div className="micro-label border-t border-surface0 px-4 py-2">{"SYS.STATUS // M1"}</div>
    </aside>
  );
}
