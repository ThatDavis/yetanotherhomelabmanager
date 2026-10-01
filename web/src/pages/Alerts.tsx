import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type AlertsConfig, api, type ChannelResult, type Webhook } from "../api";
import { Drawer } from "../components/Drawer";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";

type DrawerState = { kind: "add" } | { kind: "edit"; webhook: Webhook } | null;

const inputCls =
  "w-full border border-surface1 bg-crust px-3 py-1.5 font-mono text-sm text-text outline-none transition-colors duration-150 focus:border-accent";

export function Alerts() {
  const [config, setConfig] = useState<AlertsConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);

  const refresh = useCallback(() => {
    api<AlertsConfig>("/alerts")
      .then(setConfig)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(refresh, [refresh]);

  const toggleEmail = async (enabled: boolean) => {
    await api("/alerts/email", { method: "PUT", body: JSON.stringify({ enabled }) });
    refresh();
  };

  const toggleWebhook = async (webhook: Webhook) => {
    await api(`/webhooks/${webhook.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !webhook.enabled }),
    });
    refresh();
  };

  const testWebhook = async (webhook: Webhook): Promise<ChannelResult[]> =>
    api<{ results: ChannelResult[] }>(`/webhooks/${webhook.id}/test`, { method: "POST" }).then(
      (r) => r.results,
    );

  const remove = async (webhook: Webhook) => {
    if (!window.confirm(`Remove webhook "${webhook.name || webhook.url}"?`)) return;
    await api(`/webhooks/${webhook.id}`, { method: "DELETE" });
    refresh();
  };

  return (
    <>
      <PageHeader label="MONITOR // ALERTS" title="Alerts" />
      {error && <p className="font-mono text-sm text-status-error">API error: {error}</p>}

      {config && (
        <div className="flex flex-col gap-6">
          <section className="chamfer p-4">
            <div className="micro-label mb-3">▚ EMAIL CHANNEL</div>
            <div className="flex items-center justify-between">
              <div className="font-mono text-sm text-subtext1">
                {config.smtpConfigured ? (
                  <span className="flex items-center gap-2">
                    <StatusBadge
                      status={config.emailEnabled ? "ok" : "unknown"}
                      label={config.emailEnabled ? "ENABLED" : "DISABLED"}
                    />
                    <span className="text-subtext0">SMTP relay configured via environment</span>
                  </span>
                ) : (
                  <span className="text-subtext0">
                    SMTP not configured — set SMTP_HOST / SMTP_USER / SMTP_PASS in .env
                  </span>
                )}
              </div>
              {config.smtpConfigured && (
                <button
                  type="button"
                  onClick={() => void toggleEmail(!config.emailEnabled)}
                  className="chamfer chamfer-accent px-4 py-1.5 font-mono text-xs text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))]"
                >
                  {config.emailEnabled ? "DISABLE" : "ENABLE"}
                </button>
              )}
            </div>
          </section>

          <section className="chamfer p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="micro-label">▚ WEBHOOKS</div>
              <button
                type="button"
                onClick={() => setDrawer({ kind: "add" })}
                className="chamfer chamfer-accent px-3 py-1 font-mono text-xs text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))]"
              >
                + ADD WEBHOOK
              </button>
            </div>
            {config.webhooks.length === 0 ? (
              <p className="font-mono text-xs text-subtext0">
                No webhooks. Alerts POST as JSON to each enabled endpoint selected on a target.
              </p>
            ) : (
              <table className="w-full border-collapse font-mono text-sm">
                <thead>
                  <tr className="micro-label border-b border-surface1 text-left">
                    <th className="py-2 pr-4 font-normal">NAME</th>
                    <th className="py-2 pr-4 font-normal">URL</th>
                    <th className="py-2 pr-4 font-normal">STATE</th>
                    <th className="py-2 font-normal">ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {config.webhooks.map((w) => (
                    <WebhookRow
                      key={w.id}
                      webhook={w}
                      onToggle={() => void toggleWebhook(w)}
                      onTest={() => testWebhook(w)}
                      onEdit={() => setDrawer({ kind: "edit", webhook: w })}
                      onRemove={() => void remove(w)}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}

      <WebhookFormDrawer
        open={drawer !== null}
        webhook={drawer?.kind === "edit" ? drawer.webhook : undefined}
        onClose={() => setDrawer(null)}
        onSaved={() => {
          setDrawer(null);
          refresh();
        }}
      />
    </>
  );
}

function WebhookRow({
  webhook,
  onToggle,
  onTest,
  onEdit,
  onRemove,
}: {
  webhook: Webhook;
  onToggle: () => void;
  onTest: () => Promise<ChannelResult[]>;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [testResult, setTestResult] = useState<ChannelResult[] | null>(null);
  const [testing, setTesting] = useState(false);

  return (
    <tr className="border-b border-surface0 text-subtext1">
      <td className="py-2 pr-4 text-text">{webhook.name || "—"}</td>
      <td className="max-w-72 truncate py-2 pr-4">{webhook.url}</td>
      <td className="py-2 pr-4">
        <StatusBadge
          status={webhook.enabled ? "ok" : "unknown"}
          label={webhook.enabled ? "ON" : "OFF"}
        />
      </td>
      <td className="py-2">
        <div className="flex flex-col gap-1">
          <div className="flex gap-3">
            <button type="button" onClick={onToggle} className="text-sapphire hover:text-text">
              {webhook.enabled ? "DISABLE" : "ENABLE"}
            </button>
            <button
              type="button"
              disabled={testing}
              onClick={() => {
                setTesting(true);
                setTestResult(null);
                onTest()
                  .then(setTestResult)
                  .catch((err: Error) =>
                    setTestResult([{ channel: "webhook", ok: false, error: err.message }]),
                  )
                  .finally(() => setTesting(false));
              }}
              className="text-lavender hover:text-text disabled:opacity-50"
            >
              {testing ? "…" : "TEST"}
            </button>
            <button type="button" onClick={onEdit} className="text-subtext0 hover:text-text">
              EDIT
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="text-status-error/70 hover:text-status-error"
            >
              REMOVE
            </button>
          </div>
          {testResult?.map((r) => (
            <span
              key={r.channel}
              className={`font-mono text-xs ${r.ok ? "text-status-ok" : "text-status-error"}`}
            >
              {r.ok ? `✓ ${r.channel} delivered` : `✕ ${r.channel}: ${r.error}`}
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}

function WebhookFormDrawer({
  open,
  webhook,
  onClose,
  onSaved,
}: {
  open: boolean;
  webhook?: Webhook;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = webhook !== undefined;
  const [form, setForm] = useState({ name: "", url: "" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(webhook ? { name: webhook.name, url: webhook.url } : { name: "", url: "" });
      setError(null);
    }
  }, [open, webhook]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (editing) {
        await api(`/webhooks/${webhook.id}`, { method: "PATCH", body: JSON.stringify(form) });
      } else {
        await api("/webhooks", { method: "POST", body: JSON.stringify(form) });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Drawer
      title={editing ? `EDIT // ${webhook.name || webhook.url}` : "ADD // WEBHOOK"}
      open={open}
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="block">
          <span className="micro-label">NAME (optional label)</span>
          <input
            className={`${inputCls} mt-1`}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="micro-label">URL (receives JSON POST)</span>
          <input
            className={`${inputCls} mt-1`}
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder="https://ntfy.sh/my-topic"
            required
          />
        </label>
        {error && <p className="font-mono text-sm text-status-error">{error}</p>}
        <button
          type="submit"
          className="chamfer chamfer-accent px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))]"
        >
          {editing ? "SAVE CHANGES" : "ADD WEBHOOK"}
        </button>
      </form>
    </Drawer>
  );
}
