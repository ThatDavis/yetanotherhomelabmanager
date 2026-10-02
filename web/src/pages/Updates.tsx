import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, type Host, type UpdateSchedule } from "../api";
import { Drawer } from "../components/Drawer";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";

// M3.1 update schedules: weekly day(s)+time, host scope, OS/container toggles.
// Run-now goes through a pre-flight summary (docs/UI.md §5).

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

const inputCls =
  "w-full border border-surface1 bg-crust px-3 py-1.5 font-mono text-sm text-text outline-none transition-colors duration-150 focus:border-accent";

type DrawerState = { kind: "add" } | { kind: "edit"; schedule: UpdateSchedule } | null;

export function Updates() {
  const [schedules, setSchedules] = useState<UpdateSchedule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [preflight, setPreflight] = useState<UpdateSchedule | null>(null);

  const refresh = useCallback(() => {
    api<UpdateSchedule[]>("/schedules")
      .then(setSchedules)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(refresh, [refresh]);

  const remove = async (s: UpdateSchedule) => {
    if (!window.confirm(`Remove schedule "${s.name}"?`)) return;
    await api(`/schedules/${s.id}`, { method: "DELETE" });
    refresh();
  };

  return (
    <>
      <PageHeader label="OPS // UPDATES" title="Updates" />
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-xs text-subtext0">
          {schedules.filter((s) => s.enabled).length} enabled / {schedules.length} schedules
        </span>
        <button
          type="button"
          onClick={() => setDrawer({ kind: "add" })}
          className="chamfer chamfer-accent px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))]"
        >
          + ADD SCHEDULE
        </button>
      </div>

      {error && <p className="font-mono text-sm text-status-error">API error: {error}</p>}

      {!error && schedules.length === 0 && (
        <p className="py-8 text-center font-mono text-sm text-subtext0">
          No update schedules. Add one to keep hosts and containers current.
        </p>
      )}

      {schedules.length > 0 && (
        <table className="w-full border-collapse font-mono text-sm">
          <thead>
            <tr className="micro-label border-b border-surface1 text-left">
              <th className="py-2 pr-4 font-normal">NAME</th>
              <th className="py-2 pr-4 font-normal">WHEN</th>
              <th className="py-2 pr-4 font-normal">SCOPE</th>
              <th className="py-2 pr-4 font-normal">STEPS</th>
              <th className="py-2 pr-4 font-normal">STATE</th>
              <th className="py-2 pr-4 font-normal">LAST RUN</th>
              <th className="py-2 font-normal">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id} className="border-b border-surface0 text-subtext1">
                <td className="py-2 pr-4 text-text">{s.name}</td>
                <td className="py-2 pr-4">
                  {s.daysOfWeek.map((d) => DAYS[d]).join(" ")}{" "}
                  <span className="text-subtext0">{s.timeOfDay}</span>
                </td>
                <td className="py-2 pr-4">
                  {s.hosts.map((h) => (
                    <span key={h.id} className="mr-2">
                      {h.alias}
                      {h.self && (
                        <span
                          className="text-status-warn"
                          title="Runs the app — reboot deferred to M3.2"
                        >
                          {" "}
                          [SELF]
                        </span>
                      )}
                    </span>
                  ))}
                  {s.hosts.length === 0 && <span className="text-subtext0">—</span>}
                </td>
                <td className="py-2 pr-4">
                  {[s.osUpdates ? "os" : null, s.containerUpdates ? "containers" : null]
                    .filter(Boolean)
                    .join(" + ") || "—"}
                </td>
                <td className="py-2 pr-4">
                  <StatusBadge
                    status={s.enabled ? "ok" : "unknown"}
                    label={s.enabled ? "ENABLED" : "PAUSED"}
                  />
                </td>
                <td className="py-2 pr-4">
                  {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "—"}
                </td>
                <td className="py-2">
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setPreflight(s)}
                      className="text-sapphire hover:text-text"
                    >
                      RUN&nbsp;NOW
                    </button>
                    <button
                      type="button"
                      onClick={() => setDrawer({ kind: "edit", schedule: s })}
                      className="text-subtext0 hover:text-text"
                    >
                      EDIT
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(s)}
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

      <ScheduleFormDrawer
        open={drawer !== null}
        schedule={drawer?.kind === "edit" ? drawer.schedule : undefined}
        onClose={() => setDrawer(null)}
        onSaved={() => {
          setDrawer(null);
          refresh();
        }}
      />

      <PreflightModal schedule={preflight} onClose={() => setPreflight(null)} />
    </>
  );
}

function PreflightModal({
  schedule,
  onClose,
}: {
  schedule: UpdateSchedule | null;
  onClose: () => void;
}) {
  return (
    <Modal title={`RUN // ${schedule?.name ?? ""}`} open={schedule !== null} onClose={onClose}>
      {schedule && <PreflightBody key={schedule.id} schedule={schedule} onClose={onClose} />}
    </Modal>
  );
}

// Keyed by schedule id above: fresh state per schedule, no reset effect needed.
function PreflightBody({ schedule, onClose }: { schedule: UpdateSchedule; onClose: () => void }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const steps = [
    schedule.osUpdates ? "os.update (apt/dnf, conffiles kept)" : null,
    schedule.containerUpdates ? "container.update (docker compose projects)" : null,
  ].filter(Boolean);
  const selfHosts = schedule.hosts.filter((h) => h.self);

  const run = async () => {
    setStarting(true);
    setError(null);
    try {
      const { jobId } = await api<{ jobId: string }>(`/schedules/${schedule.id}/run`, {
        method: "POST",
      });
      window.location.href = `/jobs?job=${jobId}`;
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  };

  return (
    <Modal title={`RUN // ${schedule.name}`} open onClose={onClose}>
      <div className="micro-label mb-2">▚ PRE-FLIGHT SUMMARY</div>
      <p className="mb-3 font-mono text-sm text-subtext1">
        This will run {steps.join(" then ")} on {schedule.hosts.length}{" "}
        {schedule.hosts.length === 1 ? "host" : "hosts"}, one at a time, in the background.
      </p>
      <ul className="mb-3 font-mono text-sm text-subtext1">
        {schedule.hosts.map((h) => (
          <li key={h.id}>
            ▸ {h.alias}
            {h.self ? " [SELF — app host; reboot deferred to M3.2]" : ""}
          </li>
        ))}
      </ul>
      {selfHosts.length > 0 && (
        <p className="mb-3 font-mono text-xs text-status-warn">
          ⚠ Includes the host running this app. Updates apply normally; the app stays up until a
          later milestone adds reboot orchestration.
        </p>
      )}
      {error && <p className="mb-3 font-mono text-sm text-status-error">{error}</p>}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={run}
          disabled={starting || schedule.hosts.length === 0}
          className="chamfer chamfer-accent px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))] disabled:opacity-50"
        >
          {starting ? "STARTING…" : "CONFIRM RUN"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="border border-surface1 px-4 py-2 font-mono text-sm text-subtext0 hover:text-text"
        >
          CANCEL
        </button>
      </div>
    </Modal>
  );
}

function ScheduleFormDrawer({
  open,
  schedule,
  onClose,
  onSaved,
}: {
  open: boolean;
  schedule?: UpdateSchedule;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = schedule !== undefined;
  const [name, setName] = useState("");
  const [days, setDays] = useState<number[]>([2]); // Tuesday default
  const [timeOfDay, setTimeOfDay] = useState("03:00");
  const [osUpdates, setOsUpdates] = useState(true);
  const [containerUpdates, setContainerUpdates] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [allHosts, setAllHosts] = useState<Host[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(schedule?.name ?? "");
      setDays(schedule?.daysOfWeek ?? [2]);
      setTimeOfDay(schedule?.timeOfDay ?? "03:00");
      setOsUpdates(schedule?.osUpdates ?? true);
      setContainerUpdates(schedule?.containerUpdates ?? false);
      setEnabled(schedule?.enabled ?? true);
      setHostIds(schedule?.hosts.map((h) => h.id) ?? []);
      setError(null);
      api<Host[]>("/hosts")
        .then(setAllHosts)
        .catch(() => {});
    }
  }, [open, schedule]);

  const toggleDay = (d: number) =>
    setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d].sort()));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const body = {
        name,
        daysOfWeek: days,
        timeOfDay,
        osUpdates,
        containerUpdates,
        enabled,
        hostIds,
      };
      if (editing) {
        await api(`/schedules/${schedule.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/schedules", { method: "POST", body: JSON.stringify(body) });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Drawer
      title={editing ? `EDIT // ${schedule.name}` : "ADD // SCHEDULE"}
      open={open}
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="block">
          <span className="micro-label">NAME (lowercase-dashes)</span>
          <input
            className={`${inputCls} mt-1`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>

        <div>
          <span className="micro-label">DAYS (server-local time)</span>
          <div className="mt-1 flex gap-2">
            {DAYS.map((label, d) => (
              <button
                key={label}
                type="button"
                onClick={() => toggleDay(d)}
                aria-pressed={days.includes(d)}
                className={`border px-2 py-1 font-mono text-xs transition-colors duration-150 ${
                  days.includes(d)
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-surface1 text-subtext0 hover:text-text"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="micro-label">TIME</span>
          <input
            type="time"
            className={`${inputCls} mt-1`}
            value={timeOfDay}
            onChange={(e) => setTimeOfDay(e.target.value)}
            required
          />
        </label>

        <div className="flex flex-col gap-2 border border-surface1 bg-crust/50 p-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={osUpdates}
              onChange={(e) => setOsUpdates(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            <span className="font-mono text-xs text-subtext1">OS UPDATES (apt/dnf via SSH)</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={containerUpdates}
              onChange={(e) => setContainerUpdates(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            <span className="font-mono text-xs text-subtext1">
              CONTAINER UPDATES (docker compose projects)
            </span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            <span className="font-mono text-xs text-subtext1">ENABLED</span>
          </label>
        </div>

        <div>
          <span className="micro-label">HOSTS</span>
          {allHosts.length === 0 ? (
            <p className="mt-1 font-mono text-xs text-subtext0">
              No hosts registered — add them in{" "}
              <Link to="/guests" className="text-lavender hover:underline">
                Guests
              </Link>
              .
            </p>
          ) : (
            <div className="mt-1 flex flex-col gap-1">
              {allHosts.map((h) => (
                <label key={h.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={hostIds.includes(h.id)}
                    onChange={(e) =>
                      setHostIds(
                        e.target.checked ? [...hostIds, h.id] : hostIds.filter((id) => id !== h.id),
                      )
                    }
                    className="accent-[var(--color-accent)]"
                  />
                  <span className="font-mono text-xs text-subtext1">
                    {h.alias}
                    {h.self ? " [SELF]" : ""}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        {error && <p className="font-mono text-sm text-status-error">{error}</p>}
        <button
          type="submit"
          className="chamfer chamfer-accent px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))]"
        >
          {editing ? "SAVE CHANGES" : "ADD SCHEDULE"}
        </button>
      </form>
    </Drawer>
  );
}
