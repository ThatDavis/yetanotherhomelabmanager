import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type AgentIpsData,
  api,
  type HostRegisterResult,
  type Node,
  type ProbeResult,
} from "../api";
import { Drawer } from "../components/Drawer";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";

type DrawerState =
  | { kind: "add" }
  | { kind: "edit"; node: Node }
  | { kind: "test" | "sync"; node: Node; result: ProbeResult | null; error: string | null }
  | {
      kind: "host";
      node: Node;
      result: HostRegisterResult | null;
      error: string | null;
      script: string | null;
    }
  | {
      kind: "agent";
      node: Node;
      result: (ProbeResult & { data?: AgentIpsData }) | null;
      error: string | null;
    }
  | null;

const inputCls =
  "w-full border border-surface1 bg-crust px-3 py-1.5 font-mono text-sm text-text outline-none transition-colors duration-150 focus:border-accent";

export function Nodes() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);

  const refresh = useCallback(() => {
    api<Node[]>("/nodes")
      .then(setNodes)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(refresh, [refresh]);

  const test = async (node: Node) => {
    setDrawer({ kind: "test", node, result: null, error: null });
    try {
      const result = await api<ProbeResult>(`/nodes/${node.id}/test`, { method: "POST" });
      setDrawer({ kind: "test", node, result, error: null });
      refresh(); // fingerprint may have been pinned
    } catch (err) {
      setDrawer({ kind: "test", node, result: null, error: (err as Error).message });
    }
  };

  const sync = async (node: Node) => {
    setDrawer({ kind: "sync", node, result: null, error: null });
    try {
      const result = await api<ProbeResult>(`/nodes/${node.id}/sync`, { method: "POST" });
      setDrawer({ kind: "sync", node, result, error: null });
    } catch (err) {
      setDrawer({ kind: "sync", node, result: null, error: (err as Error).message });
    }
  };

  const unpin = async (node: Node) => {
    await api(`/nodes/${node.id}/unpin`, { method: "POST" });
    refresh();
  };

  // M3.5 onboarding: create the SSH host from the node URL, then present the
  // bootstrap script — the master key still installs by a one-time manual run.
  const registerHost = async (node: Node) => {
    setDrawer({ kind: "host", node, result: null, error: null, script: null });
    try {
      const result = await api<HostRegisterResult>(`/nodes/${node.id}/register-host`, {
        method: "POST",
      });
      const script = await fetch(`/api/hosts/${result.host.id}/bootstrap`).then((r) => r.text());
      setDrawer({ kind: "host", node, result, error: null, script });
    } catch (err) {
      setDrawer({ kind: "host", node, result: null, error: (err as Error).message, script: null });
    }
  };

  const agentIps = async (node: Node) => {
    setDrawer({ kind: "agent", node, result: null, error: null });
    try {
      const result = await api<ProbeResult & { data?: AgentIpsData }>(
        `/nodes/${node.id}/agent-ips`,
      );
      setDrawer({ kind: "agent", node, result, error: null });
    } catch (err) {
      setDrawer({ kind: "agent", node, result: null, error: (err as Error).message });
    }
  };

  // Register one agent-discovered VM as an SSH host (first address wins).
  const [guestMsgs, setGuestMsgs] = useState<Record<string, string>>({});
  const registerGuestHost = async (guest: { name: string; addresses: string[] }) => {
    const alias = guest.name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    try {
      await api("/hosts", {
        method: "POST",
        body: JSON.stringify({ alias, hostname: guest.addresses[0], username: "root" }),
      });
      setGuestMsgs((m) => ({
        ...m,
        [guest.name]: `registered as "${alias}" — bootstrap in Guests`,
      }));
    } catch (err) {
      setGuestMsgs((m) => ({ ...m, [guest.name]: (err as Error).message }));
    }
  };

  const remove = async (node: Node) => {
    if (!window.confirm(`Remove node "${node.name}"?`)) return;
    await api(`/nodes/${node.id}`, { method: "DELETE" });
    refresh();
  };

  return (
    <>
      <PageHeader label="INFRA // NODES" title="Nodes" />
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={() => setDrawer({ kind: "add" })}
          className="chamfer chamfer-accent px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))]"
        >
          + ADD NODE
        </button>
      </div>

      {error && <p className="font-mono text-sm text-status-error">API error: {error}</p>}

      {!error && nodes.length === 0 && (
        <p className="py-8 text-center font-mono text-sm text-subtext0">
          No nodes registered yet. Add your first PVE or PBS node.
        </p>
      )}

      {nodes.length > 0 && (
        <table className="w-full border-collapse font-mono text-sm">
          <thead>
            <tr className="micro-label border-b border-surface1 text-left">
              <th className="py-2 pr-4 font-normal">NAME</th>
              <th className="py-2 pr-4 font-normal">TYPE</th>
              <th className="py-2 pr-4 font-normal">URL</th>
              <th className="py-2 pr-4 font-normal">TLS PIN</th>
              <th className="py-2 font-normal">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id} className="border-b border-surface0 text-subtext1">
                <td className="py-2 pr-4 text-text">{n.name}</td>
                <td className="py-2 pr-4 uppercase">{n.type}</td>
                <td className="py-2 pr-4">{n.url}</td>
                <td className="py-2 pr-4">
                  {n.tlsFingerprint ? (
                    <StatusBadge status="ok" label="PINNED" />
                  ) : (
                    <StatusBadge status="unknown" label="TOFU" />
                  )}
                </td>
                <td className="py-2">
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => test(n)}
                      className="text-sapphire hover:text-text"
                    >
                      TEST
                    </button>
                    <button
                      type="button"
                      onClick={() => sync(n)}
                      className="text-teal hover:text-text"
                    >
                      SYNC
                    </button>
                    <button
                      type="button"
                      onClick={() => registerHost(n)}
                      className="text-sapphire hover:text-text"
                    >
                      HOST
                    </button>
                    <button
                      type="button"
                      onClick={() => agentIps(n)}
                      className="text-sapphire hover:text-text"
                    >
                      AGENT&nbsp;IPS
                    </button>
                    <button
                      type="button"
                      onClick={() => setDrawer({ kind: "edit", node: n })}
                      className="text-subtext0 hover:text-text"
                    >
                      EDIT
                    </button>
                    <button
                      type="button"
                      onClick={() => unpin(n)}
                      className="text-subtext0 hover:text-text"
                    >
                      UNPIN
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(n)}
                      className="text-status-error/70 hover:text-status-error"
                    >
                      REMOVE
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <NodeFormDrawer
        open={drawer?.kind === "add" || drawer?.kind === "edit"}
        node={drawer?.kind === "edit" ? drawer.node : undefined}
        onClose={() => setDrawer(null)}
        onSaved={() => {
          setDrawer(null);
          refresh();
        }}
      />

      <Drawer
        title={`${drawer?.kind === "sync" ? "NODE.SYNC" : "NODE.TEST"} // ${drawer && (drawer.kind === "test" || drawer.kind === "sync") ? drawer.node.name : ""}`}
        open={drawer?.kind === "test" || drawer?.kind === "sync"}
        onClose={() => setDrawer(null)}
      >
        {drawer && (drawer.kind === "test" || drawer.kind === "sync") && (
          <>
            {!drawer.result && !drawer.error && (
              <p className="font-mono text-sm text-status-running">Running…</p>
            )}
            {drawer.error && <p className="font-mono text-sm text-status-error">{drawer.error}</p>}
            {drawer.result && (
              <>
                <div className="mb-3 flex items-center gap-3">
                  <StatusBadge status={drawer.result.ok ? "ok" : "error"} />
                  <span className="font-mono text-xs text-subtext0">
                    {drawer.result.durationMs}ms
                  </span>
                </div>
                <pre className="overflow-x-auto border border-surface0 bg-crust p-3 font-mono text-xs leading-relaxed text-subtext1">
                  {drawer.result.output}
                </pre>
              </>
            )}
          </>
        )}
      </Drawer>

      <Drawer
        title={`HOST // ${drawer?.kind === "host" ? drawer.node.name : ""}`}
        open={drawer?.kind === "host"}
        onClose={() => setDrawer(null)}
      >
        {drawer?.kind === "host" && (
          <>
            {!drawer.result && !drawer.error && (
              <p className="font-mono text-sm text-status-running">Registering…</p>
            )}
            {drawer.error && <p className="font-mono text-sm text-status-error">{drawer.error}</p>}
            {drawer.result && (
              <>
                <div className="mb-3 flex items-center gap-3">
                  <StatusBadge
                    status="ok"
                    label={drawer.result.existing ? "EXISTING" : "CREATED"}
                  />
                  <span className="font-mono text-xs text-subtext0">
                    {drawer.result.host.alias} → {drawer.result.host.hostname} (root)
                  </span>
                </div>
                <p className="mb-2 font-mono text-xs text-subtext0">
                  Run this once as root on the host — the Proxmox API cannot install the key
                  remotely. Afterwards PROBE it from Guests.
                </p>
                {drawer.script && (
                  <pre className="overflow-x-auto border border-surface0 bg-crust p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-subtext1">
                    {drawer.script}
                  </pre>
                )}
              </>
            )}
          </>
        )}
      </Drawer>

      <Drawer
        title={`AGENT.IPS // ${drawer?.kind === "agent" ? drawer.node.name : ""}`}
        open={drawer?.kind === "agent"}
        onClose={() => setDrawer(null)}
      >
        {drawer?.kind === "agent" && (
          <>
            {!drawer.result && !drawer.error && (
              <p className="font-mono text-sm text-status-running">Querying guest agents…</p>
            )}
            {drawer.error && <p className="font-mono text-sm text-status-error">{drawer.error}</p>}
            {drawer.result && (
              <>
                <div className="mb-3 flex items-center gap-3">
                  <StatusBadge status={drawer.result.ok ? "ok" : "error"} />
                  <span className="font-mono text-xs text-subtext0">
                    {drawer.result.durationMs}ms
                  </span>
                </div>
                <pre className="mb-4 overflow-x-auto border border-surface0 bg-crust p-3 font-mono text-xs leading-relaxed text-subtext1">
                  {drawer.result.output}
                </pre>
                {(drawer.result.data?.guests ?? []).map((g) => (
                  <div key={g.vmid} className="mb-2 flex items-center gap-3 font-mono text-sm">
                    <span className="text-text">{g.name}</span>
                    <span className="text-subtext0">{g.addresses.join(", ")}</span>
                    <button
                      type="button"
                      onClick={() => registerGuestHost(g)}
                      className="ml-auto text-sapphire hover:text-text"
                    >
                      REGISTER
                    </button>
                  </div>
                ))}
                {Object.entries(guestMsgs).map(([name, msg]) => (
                  <p key={name} className="font-mono text-xs text-subtext0">
                    {name}: {msg}
                  </p>
                ))}
              </>
            )}
          </>
        )}
      </Drawer>
    </>
  );
}

function NodeFormDrawer({
  open,
  node,
  onClose,
  onSaved,
}: {
  open: boolean;
  node?: Node; // set when editing
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = node !== undefined;
  const [form, setForm] = useState({
    name: "",
    type: "pve" as "pve" | "pbs",
    url: "",
    tokenId: "",
    tokenSecret: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(
        node
          ? {
              name: node.name,
              type: node.type,
              url: node.url,
              tokenId: node.tokenId,
              tokenSecret: "",
            }
          : { name: "", type: "pve", url: "", tokenId: "", tokenSecret: "" },
      );
      setError(null);
    }
  }, [open, node]);

  // Type dropdown carries the default port; swap it in the URL when it matches one
  const changeType = (type: "pve" | "pbs") => {
    const from = type === "pbs" ? "8006" : "8007";
    const to = type === "pbs" ? "8007" : "8006";
    setForm({ ...form, type, url: form.url.replace(new RegExp(`:${from}$`), `:${to}`) });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = {
        name: form.name,
        type: form.type,
        url: form.url,
        tokenId: form.tokenId,
      };
      if (form.tokenSecret) body.tokenSecret = form.tokenSecret;
      if (editing) {
        await api(`/nodes/${node.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/nodes", { method: "POST", body: JSON.stringify(body) });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = (key: "name" | "url" | "tokenId", label: string, placeholder = "") => (
    <label className="block">
      <span className="micro-label">{label}</span>
      <input
        className={`${inputCls} mt-1`}
        placeholder={placeholder}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        required
      />
    </label>
  );

  return (
    <Drawer
      title={editing ? `EDIT // ${node.name}` : "REGISTER // NODE"}
      open={open}
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {field("name", "NAME (lowercase-dashes)")}
        <label className="block">
          <span className="micro-label">TYPE</span>
          <select
            className={`${inputCls} mt-1`}
            value={form.type}
            onChange={(e) => changeType(e.target.value as "pve" | "pbs")}
          >
            <option value="pve">PVE (port 8006)</option>
            <option value="pbs">PBS (port 8007)</option>
          </select>
        </label>
        {field(
          "url",
          "URL (port optional — defaults by type)",
          form.type === "pbs" ? "https://pbs.lab:8007" : "https://pve.lab:8006",
        )}
        {field("tokenId", "API TOKEN ID (user@realm!name)", "yahlm@pam!api")}
        <label className="block">
          <span className="micro-label">
            {editing ? "API TOKEN SECRET (blank = keep current)" : "API TOKEN SECRET"}
          </span>
          <input
            type="password"
            className={`${inputCls} mt-1`}
            value={form.tokenSecret}
            onChange={(e) => setForm({ ...form, tokenSecret: e.target.value })}
            required={!editing}
          />
        </label>
        {error && <p className="font-mono text-sm text-status-error">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="chamfer chamfer-accent px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))] disabled:opacity-50"
        >
          {busy ? "SAVING…" : editing ? "SAVE CHANGES" : "REGISTER NODE"}
        </button>
      </form>
    </Drawer>
  );
}
