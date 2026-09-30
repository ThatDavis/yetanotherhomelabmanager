import {
  type PublicKeyCredentialCreationOptionsJSON,
  startRegistration,
} from "@simplewebauthn/browser";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";

type Credential = { id: string; name: string; createdAt: string; lastUsedAt: string };

export function Settings() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api<Credential[]>("/auth/credentials")
      .then(setCredentials)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(refresh, [refresh]);

  const addPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const { challengeKey, ...options } = await api<
        PublicKeyCredentialCreationOptionsJSON & { challengeKey: string }
      >("/auth/register/options", { method: "POST" });
      const response = await startRegistration({ optionsJSON: options });
      await api("/auth/register/verify", {
        method: "POST",
        body: JSON.stringify({ challengeKey, response }),
      });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "registration failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader label="SYS // CONFIG" title="Settings" />
      <Panel label="PASSKEYS">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-xs text-subtext0">{credentials.length} registered</span>
          <button
            type="button"
            onClick={addPasskey}
            disabled={busy}
            className="border border-surface1 px-3 py-1 font-mono text-xs text-accent transition-colors duration-150 hover:text-text disabled:opacity-50"
          >
            {busy ? "WAITING…" : "⚿ ADD PASSKEY"}
          </button>
        </div>
        {error && <p className="mb-3 font-mono text-sm text-status-error">{error}</p>}
        {credentials.length === 0 && !error && (
          <p className="py-4 text-center font-mono text-sm text-subtext0">
            No passkeys registered.
          </p>
        )}
        {credentials.length > 0 && (
          <table className="w-full border-collapse font-mono text-sm">
            <thead>
              <tr className="micro-label border-b border-surface1 text-left">
                <th className="py-2 pr-4 font-normal">NAME</th>
                <th className="py-2 pr-4 font-normal">REGISTERED</th>
                <th className="py-2 font-normal">LAST USED</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((c) => (
                <tr key={c.id} className="border-b border-surface0 text-subtext1">
                  <td className="py-2 pr-4 text-text">{c.name || "passkey"}</td>
                  <td className="py-2 pr-4">{new Date(c.createdAt).toLocaleDateString()}</td>
                  <td className="py-2">{new Date(c.lastUsedAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
