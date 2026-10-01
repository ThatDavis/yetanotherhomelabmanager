import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, type DashboardData } from "../api";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { StatusBadge } from "../components/StatusBadge";
import { StatusStrip, stripBlocks } from "../components/StatusStrip";

const POLL_MS = 30_000;

function SummaryCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="chamfer border-0 bg-transparent px-4 py-3 [--chamfer-line:var(--color-surface1)] [--chamfer-bg:var(--color-mantle)]">
      <div className="micro-label">{label}</div>
      <div className="mt-1 font-mono text-2xl font-bold text-text">{value}</div>
      <div className="mt-1 font-mono text-xs text-subtext0">{detail}</div>
    </div>
  );
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<DashboardData>("/dashboard")
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const s = data?.summary;

  return (
    <>
      <PageHeader label="SYS.STATUS // OVERVIEW" title="Dashboard" />
      {error && <p className="mb-4 font-mono text-sm text-status-error">API error: {error}</p>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryCard
          label="TARGETS"
          value={s ? `${s.targetsUp}/${s.targetsTotal}` : "—"}
          detail={s && s.targetsDown > 0 ? `${s.targetsDown} DOWN` : "all up"}
        />
        <SummaryCard
          label="NODES"
          value={s ? `${s.nodesUp}/${s.nodesTotal}` : "—"}
          detail="pve + pbs liveness"
        />
        <SummaryCard
          label="GUESTS"
          value={data ? String(data.guests.running) : "—"}
          detail={data ? `${data.guests.stopped} stopped` : ""}
        />
        <SummaryCard
          label="LAST SYNC"
          value={
            data?.nodes[0]?.lastCheckedAt
              ? new Date(data.nodes[0].lastCheckedAt).toLocaleTimeString()
              : "—"
          }
          detail="node checks every 5 min"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel label="NODE LIVENESS">
          {!data || data.nodes.length === 0 ? (
            <div className="py-6 text-center">
              <p className="font-mono text-sm text-subtext0">No nodes registered yet.</p>
              <Link
                to="/nodes"
                className="chamfer chamfer-accent mt-4 inline-block px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))]"
              >
                + ADD YOUR FIRST PVE NODE
              </Link>
            </div>
          ) : (
            <table className="w-full border-collapse font-mono text-sm">
              <tbody>
                {data.nodes.map((n) => (
                  <tr key={n.id} className="border-b border-surface0 text-subtext1">
                    <td className="py-2 pr-4 text-text">{n.name}</td>
                    <td className="py-2 pr-4 uppercase">{n.type}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge
                        status={
                          n.status === "up" ? "ok" : n.status === "down" ? "error" : "unknown"
                        }
                        label={n.status.toUpperCase()}
                      />
                    </td>
                    <td className="py-2">
                      {n.lastCheckedAt ? new Date(n.lastCheckedAt).toLocaleTimeString() : "never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel label="RECENT ACTIVITY">
          {!data || data.recentAudit.length === 0 ? (
            <p className="py-6 text-center font-mono text-sm text-subtext0">
              Jobs and audit events will appear here.
            </p>
          ) : (
            <table className="w-full border-collapse font-mono text-xs">
              <tbody>
                {data.recentAudit.map((e) => (
                  <tr key={e.id} className="border-b border-surface0 text-subtext1">
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {new Date(e.at).toLocaleTimeString()}
                    </td>
                    <td className="py-1.5 pr-3 text-text">{e.action}</td>
                    <td className="py-1.5 pr-3">{e.target || "—"}</td>
                    <td className="py-1.5">
                      <span className={e.ok ? "text-status-ok" : "text-status-error"}>
                        {e.ok ? "✓" : "✕"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel label="TARGET STATUS // LAST 10 CHECKS">
          {!data || data.targets.length === 0 ? (
            <p className="py-4 text-center font-mono text-sm text-subtext0">
              No ping targets. Add one to start monitoring.
            </p>
          ) : (
            <table className="w-full border-collapse font-mono text-sm">
              <thead>
                <tr className="micro-label border-b border-surface1 text-left">
                  <th className="py-2 pr-4 font-normal">NAME</th>
                  <th className="py-2 pr-4 font-normal">STATUS</th>
                  <th className="py-2 pr-4 font-normal">LATENCY</th>
                  <th className="py-2 font-normal">STRIP</th>
                </tr>
              </thead>
              <tbody>
                {data.targets.map((t) => (
                  <tr key={t.id} className="border-b border-surface0 text-subtext1">
                    <td className="py-2 pr-4 text-text">{t.name}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge
                        status={
                          t.status === "up" ? "ok" : t.status === "down" ? "error" : "unknown"
                        }
                        label={t.status.toUpperCase()}
                      />
                    </td>
                    <td className="py-2 pr-4">
                      {t.lastLatencyMs !== null ? `${t.lastLatencyMs}ms` : "—"}
                    </td>
                    <td className="py-2">
                      <StatusStrip blocks={stripBlocks(t.results, t.alertAfter)} total={10} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}
