import { useCallback, useEffect, useState } from "react";
import { type AuditEntry, type AuditPage, api } from "../api";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";

type Filters = { action: string; ok: string; target: string };

const inputCls =
  "border border-surface1 bg-crust px-2 py-1 font-mono text-xs text-text outline-none transition-colors duration-150 focus:border-accent";

function queryString(filters: Filters, before: string | null): string {
  const params = new URLSearchParams();
  if (filters.action) params.set("action", filters.action);
  if (filters.ok) params.set("ok", filters.ok);
  if (filters.target) params.set("target", filters.target);
  if (before) params.set("before", before);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function Audit() {
  const [filters, setFilters] = useState<Filters>({ action: "", ok: "", target: "" });
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback((f: Filters, before: string | null, append: boolean) => {
    api<AuditPage>(`/audit${queryString(f, before)}`)
      .then((page) => {
        setEntries((prev) => (append ? [...prev, ...page.entries] : page.entries));
        setNextBefore(page.nextBefore);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    load(filters, null, false);
  }, [filters, load]);

  return (
    <>
      <PageHeader label="SEC // AUDIT" title="Audit Log" />

      <div className="mb-4 flex flex-wrap gap-2">
        <input
          className={inputCls}
          placeholder="action prefix (e.g. node.)"
          value={filters.action}
          onChange={(e) => setFilters({ ...filters, action: e.target.value })}
        />
        <input
          className={inputCls}
          placeholder="target contains"
          value={filters.target}
          onChange={(e) => setFilters({ ...filters, target: e.target.value })}
        />
        <select
          className={inputCls}
          value={filters.ok}
          onChange={(e) => setFilters({ ...filters, ok: e.target.value })}
        >
          <option value="">all results</option>
          <option value="true">ok only</option>
          <option value="false">failures only</option>
        </select>
        <span className="micro-label self-center">{entries.length} loaded</span>
      </div>

      {error && <p className="font-mono text-sm text-status-error">API error: {error}</p>}

      {!error && entries.length === 0 && (
        <p className="py-8 text-center font-mono text-sm text-subtext0">
          No audit entries match. Actions will appear here as they happen.
        </p>
      )}

      {entries.length > 0 && (
        <table className="w-full border-collapse font-mono text-sm">
          <thead>
            <tr className="micro-label border-b border-surface1 text-left">
              <th className="py-2 pr-4 font-normal">TIME</th>
              <th className="py-2 pr-4 font-normal">ACTION</th>
              <th className="py-2 pr-4 font-normal">TARGET</th>
              <th className="py-2 pr-4 font-normal">RESULT</th>
              <th className="py-2 pr-4 font-normal">MS</th>
              <th className="py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <AuditRow
                key={e.id}
                entry={e}
                expanded={expanded === e.id}
                onToggle={() => setExpanded(expanded === e.id ? null : e.id)}
              />
            ))}
          </tbody>
        </table>
      )}

      {nextBefore && (
        <button
          type="button"
          onClick={() => load(filters, nextBefore, true)}
          className="mt-3 border border-surface1 px-3 py-1 font-mono text-xs text-subtext0 transition-colors duration-150 hover:text-text"
        >
          LOAD MORE
        </button>
      )}
    </>
  );
}

function AuditRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: AuditEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-surface0 text-subtext1">
        <td className="py-2 pr-4 whitespace-nowrap">{new Date(entry.at).toLocaleString()}</td>
        <td className="py-2 pr-4 text-text">{entry.action}</td>
        <td className="py-2 pr-4">{entry.target || "—"}</td>
        <td className="py-2 pr-4">
          <StatusBadge status={entry.ok ? "ok" : "error"} />
        </td>
        <td className="py-2 pr-4">{entry.durationMs}</td>
        <td className="py-2">
          <button type="button" onClick={onToggle} className="text-subtext0 hover:text-text">
            {expanded ? "▾" : "▸"}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-surface0">
          <td colSpan={6} className="py-2 pr-4">
            <pre className="overflow-x-auto border border-surface0 bg-crust p-3 font-mono text-xs leading-relaxed text-subtext1">
              {entry.output
                ? entry.output
                : `${entry.action} on ${entry.target || "—"}: ${entry.ok ? "ok" : "failed"}`}
            </pre>
            {entry.params !== "{}" && (
              <pre className="mt-1 overflow-x-auto border border-surface0 bg-crust p-3 font-mono text-xs leading-relaxed text-subtext0">
                {entry.params}
              </pre>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
