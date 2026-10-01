import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type AuditEntry, api, type PingTarget } from "../api";
import { Drawer } from "../components/Drawer";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { PingGraph } from "../components/PingGraph";
import { StatusBadge } from "../components/StatusBadge";
import { StatusStrip, stripBlocks } from "../components/StatusStrip";

type TargetWithMeta = PingTarget & {
  uptimePct: number | null;
  results: { ok: boolean; at: string; latencyMs: number | null }[];
};
type TargetDetail = TargetWithMeta & { transitions: AuditEntry[] };

type DrawerState =
  | { kind: "add" }
  | { kind: "edit"; target: PingTarget }
  | { kind: "detail"; target: TargetWithMeta }
  | null;

const STATUS_MAP = { up: "ok", down: "error", unknown: "unknown" } as const;

const inputCls =
  "w-full border border-surface1 bg-crust px-3 py-1.5 font-mono text-sm text-text outline-none transition-colors duration-150 focus:border-accent";

export function Uptime() {
  const [targets, setTargets] = useState<TargetWithMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);

  const refresh = useCallback(() => {
    api<TargetWithMeta[]>("/targets")
      .then(setTargets)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(refresh, [refresh]);

  const checkNow = async (t: PingTarget) => {
    await api(`/targets/${t.id}/check`, { method: "POST" });
    refresh();
  };

  const remove = async (t: PingTarget) => {
    if (!window.confirm(`Remove target "${t.name}"?`)) return;
    await api(`/targets/${t.id}`, { method: "DELETE" });
    refresh();
  };

  return (
    <>
      <PageHeader label="MONITOR // UPTIME" title="Uptime" />
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-xs text-subtext0">
          {targets.filter((t) => t.status === "down").length} down / {targets.length} targets
        </span>
        <button
          type="button"
          onClick={() => setDrawer({ kind: "add" })}
          className="chamfer chamfer-accent px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))]"
        >
          + ADD TARGET
        </button>
      </div>

      {error && <p className="font-mono text-sm text-status-error">API error: {error}</p>}

      {!error && targets.length === 0 && (
        <p className="py-8 text-center font-mono text-sm text-subtext0">
          No ping targets. Add one to start monitoring.
        </p>
      )}

      {targets.length > 0 && (
        <table className="w-full border-collapse font-mono text-sm">
          <thead>
            <tr className="micro-label border-b border-surface1 text-left">
              <th className="py-2 pr-4 font-normal">NAME</th>
              <th className="py-2 pr-4 font-normal">HOST</th>
              <th className="py-2 pr-4 font-normal">STATUS</th>
              <th className="py-2 pr-4 font-normal">UPTIME</th>
              <th className="py-2 pr-4 font-normal">STRIP</th>
              <th className="py-2 font-normal">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => (
              <tr key={t.id} className="border-b border-surface0 text-subtext1">
                <td className="py-2 pr-4 text-text">{t.name}</td>
                <td className="py-2 pr-4">{t.host}</td>
                <td className="py-2 pr-4">
                  <StatusBadge status={STATUS_MAP[t.status]} label={t.status.toUpperCase()} />
                </td>
                <td className="py-2 pr-4">{t.uptimePct !== null ? `${t.uptimePct}%` : "—"}</td>
                <td className="py-2 pr-4">
                  <StatusStrip blocks={stripBlocks(t.results, t.alertAfter)} total={10} />
                </td>
                <td className="py-2">
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setDrawer({ kind: "detail", target: t })}
                      className="text-lavender hover:text-text"
                    >
                      VIEW
                    </button>
                    <button
                      type="button"
                      onClick={() => checkNow(t)}
                      className="text-sapphire hover:text-text"
                    >
                      CHECK
                    </button>
                    <button
                      type="button"
                      onClick={() => setDrawer({ kind: "edit", target: t })}
                      className="text-subtext0 hover:text-text"
                    >
                      EDIT
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(t)}
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

      <TargetFormDrawer
        open={drawer?.kind === "add" || drawer?.kind === "edit"}
        target={drawer?.kind === "edit" ? drawer.target : undefined}
        onClose={() => setDrawer(null)}
        onSaved={() => {
          setDrawer(null);
          refresh();
        }}
      />

      <DetailModal
        target={drawer?.kind === "detail" ? drawer.target : null}
        onClose={() => setDrawer(null)}
      />
    </>
  );
}

function DetailModal({ target, onClose }: { target: TargetWithMeta | null; onClose: () => void }) {
  const [detail, setDetail] = useState<TargetDetail | null>(null);

  useEffect(() => {
    setDetail(null);
    if (target) {
      api<TargetDetail>(`/targets/${target.id}/detail`)
        .then(setDetail)
        .catch(() => {});
    }
  }, [target]);

  return (
    <Modal title={`TARGET // ${target?.name ?? ""}`} open={target !== null} onClose={onClose} wide>
      {target && !detail && <p className="font-mono text-sm text-status-running">Loading…</p>}
      {detail && (
        <>
          <div className="mb-4 flex items-center gap-3">
            <StatusBadge status={STATUS_MAP[detail.status]} label={detail.status.toUpperCase()} />
            <span className="font-mono text-xs text-subtext0">
              {detail.host} · every {detail.intervalSec}s · alert after {detail.alertAfter}
            </span>
          </div>

          <div className="mb-4">
            <PingGraph results={[...detail.results].reverse()} />
          </div>

          <div className="micro-label mb-2">▚ RECENT RESULTS</div>
          <table className="mb-4 w-full border-collapse font-mono text-xs">
            <tbody>
              {detail.results.slice(0, 20).map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: results are append-only, never reordered
                <tr key={i} className="border-b border-surface0 text-subtext1">
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {new Date(r.at).toLocaleTimeString()}
                  </td>
                  <td className="py-1">
                    <span className={r.ok ? "text-status-ok" : "text-status-error"}>
                      {r.ok ? "✓ up" : "✕ fail"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="micro-label mb-2">▚ TRANSITIONS</div>
          {detail.transitions.length === 0 ? (
            <p className="font-mono text-xs text-subtext0">No state transitions recorded.</p>
          ) : (
            <table className="w-full border-collapse font-mono text-xs">
              <tbody>
                {detail.transitions.map((t) => (
                  <tr key={t.id} className="border-b border-surface0 text-subtext1">
                    <td className="py-1 pr-3 whitespace-nowrap">
                      {new Date(t.at).toLocaleString()}
                    </td>
                    <td className="py-1">{t.output}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Modal>
  );
}

function TargetFormDrawer({
  open,
  target,
  onClose,
  onSaved,
}: {
  open: boolean;
  target?: PingTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = target !== undefined;
  const [form, setForm] = useState({ name: "", host: "", intervalSec: "60", alertAfter: "3" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(
        target
          ? {
              name: target.name,
              host: target.host,
              intervalSec: String(target.intervalSec),
              alertAfter: String(target.alertAfter),
            }
          : { name: "", host: "", intervalSec: "60", alertAfter: "3" },
      );
      setError(null);
    }
  }, [open, target]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const body = {
        name: form.name,
        host: form.host,
        intervalSec: Number(form.intervalSec),
        alertAfter: Number(form.alertAfter),
      };
      if (editing) {
        await api(`/targets/${target.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/targets", { method: "POST", body: JSON.stringify(body) });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Drawer
      title={editing ? `EDIT // ${target.name}` : "ADD // TARGET"}
      open={open}
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {(
          [
            ["name", "NAME (lowercase-dashes)"],
            ["host", "HOST / IP"],
            ["intervalSec", "INTERVAL (seconds, min 10)"],
            ["alertAfter", "FAILURES BEFORE DOWN/ALERT"],
          ] as const
        ).map(([key, label]) => (
          <label className="block" key={key}>
            <span className="micro-label">{label}</span>
            <input
              className={`${inputCls} mt-1`}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              required
            />
          </label>
        ))}
        {error && <p className="font-mono text-sm text-status-error">{error}</p>}
        <button
          type="submit"
          className="chamfer chamfer-accent px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))]"
        >
          {editing ? "SAVE CHANGES" : "ADD TARGET"}
        </button>
      </form>
    </Drawer>
  );
}
