import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, type Host, type ProbeResult } from "../api";
import { Drawer } from "../components/Drawer";
import { GuestInventory } from "../components/GuestInventory";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { StatusBadge } from "../components/StatusBadge";
import { Terminal } from "../components/Terminal";

type DrawerState =
  | { kind: "add" }
  | { kind: "bootstrap"; host: Host; script: string }
  | { kind: "probe"; host: Host; result: ProbeResult | null; error: string | null }
  | { kind: "edit"; host: Host }
  | { kind: "reboot"; host: Host }
  | null;

const inputCls =
  "w-full border border-surface1 bg-crust px-3 py-1.5 font-mono text-sm text-text outline-none transition-colors duration-150 focus:border-accent";

export function Guests() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);

  const refresh = useCallback(() => {
    api<Host[]>("/hosts")
      .then(setHosts)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(refresh, [refresh]);

  const probe = async (host: Host) => {
    setDrawer({ kind: "probe", host, result: null, error: null });
    try {
      const result = await api<ProbeResult>(`/hosts/${host.id}/probe`, { method: "POST" });
      setDrawer({ kind: "probe", host, result, error: null });
    } catch (err) {
      setDrawer({ kind: "probe", host, result: null, error: (err as Error).message });
    }
  };

  const showBootstrap = async (host: Host) => {
    const res = await fetch(`/api/hosts/${host.id}/bootstrap`);
    setDrawer({ kind: "bootstrap", host, script: await res.text() });
  };

  const removeHost = async (host: Host) => {
    if (!window.confirm(`Remove host "${host.alias}"?`)) return;
    await api(`/hosts/${host.id}`, { method: "DELETE" });
    refresh();
  };

  return (
    <>
      <PageHeader label="INFRA // GUESTS" title="Guests" />
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={() => setDrawer({ kind: "add" })}
          className="chamfer chamfer-accent px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))]"
        >
          + ADD HOST
        </button>
      </div>

      <GuestInventory />

      <div className="mt-6">
        <Panel label="SSH HOSTS">
          {error && <p className="font-mono text-sm text-status-error">API error: {error}</p>}

          {!error && hosts.length === 0 && (
            <p className="py-4 text-center font-mono text-sm text-subtext0">
              No hosts registered yet. Add your first host, then run its bootstrap script.
            </p>
          )}

          {hosts.length > 0 && (
            <table className="w-full border-collapse font-mono text-sm">
              <thead>
                <tr className="micro-label border-b border-surface1 text-left">
                  <th className="py-2 pr-4 font-normal">ALIAS</th>
                  <th className="py-2 pr-4 font-normal">ADDRESS</th>
                  <th className="py-2 pr-4 font-normal">NOTES</th>
                  <th className="py-2 pr-4 font-normal">BOOT</th>
                  <th className="py-2 font-normal">ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {hosts.map((h) => (
                  <tr key={h.id} className="border-b border-surface0 text-subtext1">
                    <td className="py-2 pr-4 text-text">
                      {h.alias}
                      {h.self && (
                        <span
                          className="ml-2 text-status-warn"
                          title="Runs the app — reboot refused"
                        >
                          [SELF]
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {h.username}@{h.hostname}:{h.port}
                    </td>
                    <td className="py-2 pr-4">{h.notes}</td>
                    <td className="py-2 pr-4">{h.bootOrder}</td>
                    <td className="py-2">
                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={() => probe(h)}
                          className="text-sapphire hover:text-text"
                        >
                          PROBE
                        </button>
                        <button
                          type="button"
                          onClick={() => setDrawer({ kind: "reboot", host: h })}
                          className="text-subtext0 hover:text-text"
                        >
                          REBOOT
                        </button>
                        <button
                          type="button"
                          onClick={() => setDrawer({ kind: "edit", host: h })}
                          className="text-subtext0 hover:text-text"
                        >
                          EDIT
                        </button>
                        <button
                          type="button"
                          onClick={() => showBootstrap(h)}
                          className="text-subtext0 hover:text-text"
                        >
                          BOOTSTRAP
                        </button>
                        <button
                          type="button"
                          onClick={() => removeHost(h)}
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
        </Panel>
      </div>

      <AddHostDrawer
        open={drawer?.kind === "add"}
        onClose={() => setDrawer(null)}
        onAdded={() => {
          setDrawer(null);
          refresh();
        }}
      />

      <EditHostDrawer
        open={drawer?.kind === "edit"}
        host={drawer?.kind === "edit" ? drawer.host : undefined}
        onClose={() => setDrawer(null)}
        onSaved={() => {
          setDrawer(null);
          refresh();
        }}
      />

      <RebootModal
        host={drawer?.kind === "reboot" ? drawer.host : null}
        onClose={() => setDrawer(null)}
      />

      <Drawer
        title={`BOOTSTRAP // ${drawer?.kind === "bootstrap" ? drawer.host.alias : ""}`}
        open={drawer?.kind === "bootstrap"}
        onClose={() => setDrawer(null)}
      >
        {drawer?.kind === "bootstrap" && (
          <>
            <p className="mb-3 font-mono text-xs text-subtext0">
              Run this on {drawer.host.username}@{drawer.host.hostname} once. It authorizes the
              yahlm master key.
            </p>
            <pre className="overflow-x-auto border border-surface0 bg-crust p-3 font-mono text-xs text-subtext1">
              {drawer.script}
            </pre>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(drawer.script)}
              className="mt-3 border border-surface1 px-3 py-1.5 font-mono text-xs text-subtext0 transition-colors duration-150 hover:text-text"
            >
              COPY SCRIPT
            </button>
          </>
        )}
      </Drawer>

      <Drawer
        title={`HEALTH.CHECK // ${drawer?.kind === "probe" ? drawer.host.alias : ""}`}
        open={drawer?.kind === "probe"}
        onClose={() => setDrawer(null)}
      >
        {drawer?.kind === "probe" && (
          <>
            {!drawer.result && !drawer.error && (
              <p className="font-mono text-sm text-status-running">Running probe…</p>
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
                {drawer.result.data && <Terminal lines={drawer.result.data.lines} />}
              </>
            )}
          </>
        )}
      </Drawer>
    </>
  );
}

function AddHostDrawer({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [form, setForm] = useState({
    alias: "",
    hostname: "",
    port: "22",
    username: "root",
    notes: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/hosts", {
        method: "POST",
        body: JSON.stringify({ ...form, port: Number(form.port) }),
      });
      setForm({ alias: "", hostname: "", port: "22", username: "root", notes: "" });
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof typeof form, label: string) => (
    <label className="block">
      <span className="micro-label">{label}</span>
      <input
        className={`${inputCls} mt-1`}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        required={key !== "notes"}
      />
    </label>
  );

  return (
    <Drawer title="REGISTER // HOST" open={open} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {field("alias", "ALIAS (lowercase-dashes)")}
        {field("hostname", "HOSTNAME / IP")}
        {field("port", "SSH PORT")}
        {field("username", "SSH USER")}
        {field("notes", "NOTES")}
        {error && <p className="font-mono text-sm text-status-error">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="chamfer chamfer-accent px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))] disabled:opacity-50"
        >
          {busy ? "REGISTERING…" : "REGISTER HOST"}
        </button>
      </form>
    </Drawer>
  );
}

function EditHostDrawer({
  open,
  host,
  onClose,
  onSaved,
}: {
  open: boolean;
  host?: Host;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [self, setSelf] = useState(false);
  const [bootOrder, setBootOrder] = useState("0");
  const [services, setServices] = useState<{ name: string; port: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && host) {
      setNotes(host.notes);
      setSelf(host.self);
      setBootOrder(String(host.bootOrder));
      setServices(host.services.map((s) => ({ name: s.name, port: String(s.port) })));
      setError(null);
    }
  }, [open, host]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(`/hosts/${host?.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          notes,
          self,
          bootOrder: Number(bootOrder),
          services: services
            .filter((s) => s.name.trim() !== "")
            .map((s) => ({ name: s.name.trim(), port: Number(s.port) })),
        }),
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Drawer title={`EDIT // ${host?.alias ?? ""}`} open={open} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="block">
          <span className="micro-label">NOTES</span>
          <input
            className={`${inputCls} mt-1`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="micro-label">BOOT ORDER (reboots roll low→high)</span>
          <input
            type="number"
            min={0}
            max={999}
            className={`${inputCls} mt-1`}
            value={bootOrder}
            onChange={(e) => setBootOrder(e.target.value)}
            required
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={self}
            onChange={(e) => setSelf(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          <span className="font-mono text-xs text-subtext1">
            THIS HOST RUNS THE APP (reboot refused; auto-reboots skip it)
          </span>
        </label>

        <div>
          <span className="micro-label">SERVICES (TCP-checked by host.verify)</span>
          <div className="mt-1 flex flex-col gap-2">
            {services.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: editable form rows are positional, rows have no stable id
              <div key={i} className="flex gap-2">
                <input
                  className={`${inputCls} flex-1`}
                  value={s.name}
                  placeholder="name"
                  onChange={(e) =>
                    setServices(
                      services.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
                <input
                  className={`${inputCls} w-24`}
                  type="number"
                  min={1}
                  max={65535}
                  value={s.port}
                  placeholder="port"
                  onChange={(e) =>
                    setServices(
                      services.map((x, j) => (j === i ? { ...x, port: e.target.value } : x)),
                    )
                  }
                />
                <button
                  type="button"
                  onClick={() => setServices(services.filter((_, j) => j !== i))}
                  className="px-2 font-mono text-status-error/70 hover:text-status-error"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setServices([...services, { name: "", port: "" }])}
              className="border border-surface1 px-3 py-1 font-mono text-xs text-subtext0 hover:text-text"
            >
              + ADD SERVICE
            </button>
          </div>
        </div>
        {error && <p className="font-mono text-sm text-status-error">{error}</p>}
        <button
          type="submit"
          className="chamfer chamfer-accent px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))]"
        >
          SAVE CHANGES
        </button>
      </form>
    </Drawer>
  );
}

function RebootModal({ host, onClose }: { host: Host | null; onClose: () => void }) {
  const [confirmText, setConfirmText] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (host) {
      setConfirmText("");
      setStarting(false);
      setError(null);
    }
  }, [host]);

  // Same keyed-remount pattern would be cleaner, but host identity changes on
  // every refresh() — reset on open transition instead.
  const isSelf = host?.self ?? false;
  const canConfirm = confirmText === "REBOOT" && !isSelf && !starting;

  const reboot = async () => {
    if (!host) return;
    setStarting(true);
    setError(null);
    try {
      const { jobId } = await api<{ jobId: string }>(`/hosts/${host.id}/reboot`, {
        method: "POST",
      });
      window.location.href = `/jobs?job=${jobId}`;
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  };

  return (
    <Modal title={`REBOOT // ${host?.alias ?? ""}`} open={host !== null} onClose={onClose}>
      {host && (
        <>
          {isSelf ? (
            <p className="mb-3 font-mono text-sm text-status-warn">
              ⚠ This host runs the app. Rebooting it would kill the orchestrator mid-job — the API
              refuses. Reboot it manually.
            </p>
          ) : (
            <p className="mb-3 font-mono text-sm text-subtext1">
              {host.alias} will reboot and the job will wait for it to come back (up to 10 minutes).
              Type <span className="text-status-error">REBOOT</span> to confirm.
            </p>
          )}
          {!isSelf && (
            <input
              className={`${inputCls} mb-3`}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="REBOOT"
            />
          )}
          {error && <p className="mb-3 font-mono text-sm text-status-error">{error}</p>}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={reboot}
              disabled={!canConfirm}
              className="chamfer px-4 py-2 font-mono text-sm text-status-error [--chamfer-line:var(--color-status-error)] [--chamfer-bg:color-mix(in_oklab,var(--color-status-error)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-status-error)_20%,var(--color-mantle))] disabled:opacity-50"
            >
              {starting ? "STARTING…" : "REBOOT HOST"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="border border-surface1 px-4 py-2 font-mono text-sm text-subtext0 hover:text-text"
            >
              CANCEL
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
