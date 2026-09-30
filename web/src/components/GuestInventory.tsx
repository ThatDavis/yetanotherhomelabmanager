import { useCallback, useEffect, useState } from "react";
import { api, type Guest, type SyncResult } from "../api";
import { Drawer } from "./Drawer";
import { Panel } from "./Panel";
import { type Status, StatusBadge } from "./StatusBadge";

const STATUS_MAP: Record<string, Status> = {
  running: "ok",
  stopped: "unknown",
  paused: "warn",
  suspended: "warn",
};

export function GuestInventory() {
  const [guests, setGuests] = useState<Guest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  const refresh = useCallback(() => {
    api<Guest[]>("/guests")
      .then(setGuests)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(refresh, [refresh]);

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await api<SyncResult>("/sync", { method: "POST" });
      setSyncResult(result);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Panel label="PVE INVENTORY">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-xs text-subtext0">{guests.length} guests</span>
        <button
          type="button"
          onClick={sync}
          disabled={syncing}
          className="border border-surface1 px-3 py-1 font-mono text-xs text-sapphire transition-colors duration-150 hover:text-text disabled:opacity-50"
        >
          {syncing ? "SYNCING…" : "⟳ SYNC ALL"}
        </button>
      </div>

      {error && <p className="font-mono text-sm text-status-error">API error: {error}</p>}

      {!error && guests.length === 0 && (
        <p className="py-4 text-center font-mono text-sm text-subtext0">
          No inventory yet. Register a PVE node and sync.
        </p>
      )}

      {guests.length > 0 && (
        <table className="w-full border-collapse font-mono text-sm">
          <thead>
            <tr className="micro-label border-b border-surface1 text-left">
              <th className="py-2 pr-4 font-normal">NAME</th>
              <th className="py-2 pr-4 font-normal">VMID</th>
              <th className="py-2 pr-4 font-normal">TYPE</th>
              <th className="py-2 pr-4 font-normal">NODE</th>
              <th className="py-2 font-normal">STATUS</th>
            </tr>
          </thead>
          <tbody>
            {guests.map((g) => (
              <tr key={g.id} className="border-b border-surface0 text-subtext1">
                <td className="py-2 pr-4 text-text">{g.name}</td>
                <td className="py-2 pr-4">{g.vmid}</td>
                <td className="py-2 pr-4 uppercase">{g.type}</td>
                <td className="py-2 pr-4">{g.pveNode}</td>
                <td className="py-2">
                  <StatusBadge
                    status={STATUS_MAP[g.status] ?? "unknown"}
                    label={g.status.toUpperCase()}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Drawer
        title="NODE.SYNC // ALL"
        open={syncResult !== null}
        onClose={() => setSyncResult(null)}
      >
        {syncResult && (
          <>
            <div className="mb-3">
              <StatusBadge
                status={syncResult.ok ? "ok" : "warn"}
                label={syncResult.ok ? "ALL OK" : "PARTIAL"}
              />
            </div>
            {syncResult.results.map((r) => (
              <div key={r.node} className="mb-4">
                <div className="micro-label mb-1">
                  {r.ok ? "✓" : "✕"} {r.node}
                </div>
                <pre className="overflow-x-auto border border-surface0 bg-crust p-2 font-mono text-xs text-subtext1">
                  {r.output}
                </pre>
              </div>
            ))}
          </>
        )}
      </Drawer>
    </Panel>
  );
}
