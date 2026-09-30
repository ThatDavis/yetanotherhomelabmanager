import type { OutputLine } from "../api";

// Combined tagged stream, rendered verbatim (docs/ARCHITECTURE.md §Design Principles 4).
export function Terminal({ lines }: { lines: OutputLine[] }) {
  return (
    <pre className="overflow-x-auto border border-surface0 bg-crust p-3 font-mono text-xs leading-relaxed text-subtext1">
      {lines.map((l, i) =>
        l.stream === "stderr" ? (
          <span key={i} className="block text-status-error">
            ! {l.line}
          </span>
        ) : (
          <span key={i} className="block">
            {l.line}
          </span>
        ),
      )}
    </pre>
  );
}
