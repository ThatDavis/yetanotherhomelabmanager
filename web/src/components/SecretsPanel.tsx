import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Panel } from "./Panel";

type SecretMeta = { id: string; createdAt: string; updatedAt: string };

// Secrets management: names/metadata only (values never leave the server),
// guarded delete, master key rotation.
export function SecretsPanel() {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [confirm, setConfirm] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<SecretMeta[]>("/secrets")
      .then(setSecrets)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(refresh, [refresh]);

  const remove = async (id: string) => {
    if (!window.confirm(`Delete secret "${id}"? This cannot be undone.`)) return;
    setError(null);
    try {
      await api(`/secrets/${id}`, { method: "DELETE" });
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const rotate = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ rotated: number; warning: string }>("/secrets/rotate-key", {
        method: "POST",
        body: JSON.stringify({ newMasterKey: newKey }),
      });
      setNotice(`${res.rotated} secrets re-encrypted. ${res.warning}`);
      setRotating(false);
      setNewKey("");
      setConfirm("");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Panel label="SECRETS">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-xs text-subtext0">
          {secrets.length} stored (values never leave the server)
        </span>
        <button
          type="button"
          onClick={() => setRotating(!rotating)}
          className="border border-surface1 px-3 py-1 font-mono text-xs text-status-warn transition-colors duration-150 hover:text-text"
        >
          ⚠ ROTATE MASTER KEY
        </button>
      </div>

      {notice && <p className="mb-3 font-mono text-sm text-status-warn">{notice}</p>}
      {error && <p className="mb-3 font-mono text-sm text-status-error">{error}</p>}

      {rotating && (
        <form onSubmit={rotate} className="mb-4 border border-status-warn/40 bg-crust p-3">
          <p className="mb-3 font-mono text-xs text-subtext0">
            Re-encrypts all secrets under a new key. You must update MASTER_KEY in the environment
            and restart the app immediately after — until then, secret operations will fail.
            Generate a key with: openssl rand -hex 32
          </p>
          <input
            className="mb-2 w-full border border-surface1 bg-mantle px-3 py-1.5 font-mono text-sm text-text outline-none focus:border-status-warn"
            placeholder="new master key (64 hex chars)"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            required
          />
          <input
            className="mb-3 w-full border border-surface1 bg-mantle px-3 py-1.5 font-mono text-sm text-text outline-none focus:border-status-warn"
            placeholder="type ROTATE to confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          <button
            type="submit"
            disabled={confirm !== "ROTATE" || newKey.length !== 64}
            className="border border-status-warn/60 px-4 py-1.5 font-mono text-sm text-status-warn transition-colors duration-150 hover:bg-status-warn/10 disabled:opacity-40"
          >
            ROTATE NOW
          </button>
        </form>
      )}

      {secrets.length === 0 && !error && (
        <p className="py-4 text-center font-mono text-sm text-subtext0">No secrets stored.</p>
      )}

      {secrets.length > 0 && (
        <table className="w-full border-collapse font-mono text-sm">
          <thead>
            <tr className="micro-label border-b border-surface1 text-left">
              <th className="py-2 pr-4 font-normal">ID</th>
              <th className="py-2 pr-4 font-normal">CREATED</th>
              <th className="py-2 pr-4 font-normal">UPDATED</th>
              <th className="py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {secrets.map((s) => (
              <tr key={s.id} className="border-b border-surface0 text-subtext1">
                <td className="py-2 pr-4 text-text">{s.id}</td>
                <td className="py-2 pr-4">{new Date(s.createdAt).toLocaleDateString()}</td>
                <td className="py-2 pr-4">{new Date(s.updatedAt).toLocaleDateString()}</td>
                <td className="py-2">
                  <button
                    type="button"
                    onClick={() => remove(s.id)}
                    className="text-status-error/70 hover:text-status-error"
                  >
                    DELETE
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
