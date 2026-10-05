import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api, type Job, type JobStep } from "../api";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { type Status, StatusBadge } from "../components/StatusBadge";

// Job center (docs/UI.md §5): persistent list of jobs with live status.
// Live updates via SSE per job; poll fallback when SSE fails.

const JOB_STATUS: Record<Job["status"], { status: Status; label: string }> = {
  running: { status: "running", label: "RUNNING" },
  succeeded: { status: "ok", label: "OK" },
  failed: { status: "error", label: "FAILED" },
};

const POLL_MS = 2000;

export function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();

  const refresh = useCallback(() => {
    api<Job[]>("/jobs")
      .then(setJobs)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(refresh, [refresh]);

  // Deep link from toasts / run-now: /jobs?job=<id>
  useEffect(() => {
    const job = params.get("job");
    if (job) {
      setOpenId(job);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  return (
    <>
      <PageHeader label="OPS // JOBS" title="Jobs" />
      {error && <p className="font-mono text-sm text-status-error">API error: {error}</p>}
      {!error && jobs.length === 0 && (
        <p className="py-8 text-center font-mono text-sm text-subtext0">
          No jobs yet. Update schedules run as jobs — start one from{" "}
          <a href="/updates" className="text-lavender hover:underline">
            Updates
          </a>
          .
        </p>
      )}
      {jobs.length > 0 && (
        <table className="w-full border-collapse font-mono text-sm">
          <thead>
            <tr className="micro-label border-b border-surface1 text-left">
              <th className="py-2 pr-4 font-normal">STATUS</th>
              <th className="py-2 pr-4 font-normal">TRIGGER</th>
              <th className="py-2 pr-4 font-normal">SCHEDULE</th>
              <th className="py-2 pr-4 font-normal">STEPS</th>
              <th className="py-2 pr-4 font-normal">STARTED</th>
              <th className="py-2 pr-4 font-normal">DURATION</th>
              <th className="py-2 font-normal">DETAIL</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="border-b border-surface0 text-subtext1">
                <td className="py-2 pr-4">
                  <StatusBadge
                    status={JOB_STATUS[j.status].status}
                    label={JOB_STATUS[j.status].label}
                  />
                </td>
                <td className="py-2 pr-4">{j.trigger}</td>
                <td className="py-2 pr-4 text-text">{j.schedule?.name ?? "—"}</td>
                <td className="py-2 pr-4">
                  {j.steps.length}
                  {j.status === "running" ? " (live)" : ""}
                </td>
                <td className="py-2 pr-4">{new Date(j.startedAt).toLocaleString()}</td>
                <td className="py-2 pr-4">
                  {j.finishedAt
                    ? `${Math.round((new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()) / 1000)}s`
                    : "—"}
                </td>
                <td className="py-2">
                  <button
                    type="button"
                    onClick={() => setOpenId(j.id)}
                    className="text-lavender hover:text-text"
                  >
                    VIEW
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <JobDetailModal jobId={openId} onChanged={refresh} onClose={() => setOpenId(null)} />
    </>
  );
}

function JobDetailModal({
  jobId,
  onChanged,
  onClose,
}: {
  jobId: string | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!jobId) return;
    api<Job>(`/jobs/${jobId}`)
      .then(setJob)
      .catch(() => setJob(null));
  }, [jobId]);

  useEffect(() => {
    setJob(null);
    setExpanded(null);
    load();
  }, [load]);

  // SSE with poll fallback (docs/UI.md §5).
  const isRunning = job?.status === "running";
  useEffect(() => {
    if (!jobId || !isRunning) return;
    let closed = false;
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    const onStep = (raw: MessageEvent) => {
      const step = JSON.parse(raw.data) as JobStep;
      setJob((j) => (j ? { ...j, steps: [...j.steps.filter((s) => s.id !== step.id), step] } : j));
    };
    const onStatus = (raw: MessageEvent) => {
      const { status } = JSON.parse(raw.data) as { status?: string };
      if (status === "succeeded" || status === "failed") {
        source.close();
        closed = true;
        load(); // final state + finishedAt
        onChanged(); // refresh the list behind the modal
      }
    };
    source.addEventListener("step", onStep);
    source.addEventListener("status", onStatus);
    source.onerror = () => {
      source.close();
      if (!closed) {
        const timer = setInterval(() => {
          api<Job>(`/jobs/${jobId}`).then((j) => {
            setJob(j);
            if (j.status !== "running") {
              clearInterval(timer);
              onChanged();
            }
          });
        }, POLL_MS);
      }
    };
    return () => source.close();
  }, [jobId, isRunning, load, onChanged]);

  return (
    <Modal
      title={`${job?.kind === "reboot" ? "REBOOT" : "JOB"} // ${job?.schedule?.name ?? jobId ?? ""}`}
      open={jobId !== null}
      onClose={onClose}
      wide
    >
      {!job && <p className="font-mono text-sm text-status-running">Loading…</p>}
      {job && (
        <>
          <div className="mb-4 flex items-center gap-3">
            <StatusBadge
              status={JOB_STATUS[job.status].status}
              label={JOB_STATUS[job.status].label}
            />
            <span className="font-mono text-xs text-subtext0">
              {job.trigger} · started {new Date(job.startedAt).toLocaleString()}
              {isRunning && <span className="text-status-running"> · live</span>}
            </span>
          </div>

          {job.steps.length === 0 && (
            <p className="font-mono text-sm text-subtext0">
              {isRunning ? "Waiting for first step…" : "No steps recorded."}
            </p>
          )}

          <div className="flex flex-col gap-2">
            {job.steps.map((s) => (
              <div key={s.id} className="border border-surface0 bg-crust/40">
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left font-mono text-sm"
                >
                  {s.finishedAt === null ? (
                    <span className="animate-pulse text-status-running">▶</span>
                  ) : (
                    <span className={s.ok ? "text-status-ok" : "text-status-error"}>
                      {s.ok ? "✓" : "✕"}
                    </span>
                  )}
                  <span className="text-text">{s.host?.alias ?? "?"}</span>
                  <span className="text-subtext0">{s.name}</span>
                  {s.phase !== "" && (
                    <span className="text-lavender">[{s.phase.toUpperCase()}]</span>
                  )}
                  <span className="text-subtext0">
                    {s.finishedAt === null
                      ? "running…"
                      : s.durationMs >= 1000
                        ? `${(s.durationMs / 1000).toFixed(1)}s`
                        : `${s.durationMs}ms`}
                  </span>
                  {s.rebootPending && (
                    <span
                      className="text-status-warn"
                      title="Reboot needed — orchestration lands in M3.2"
                    >
                      ⟳ REBOOT PENDING
                    </span>
                  )}
                  <span className="ml-auto text-subtext0">{expanded === s.id ? "▾" : "▸"}</span>
                </button>
                {expanded === s.id && (
                  <pre className="max-h-64 overflow-auto border-t border-surface0 p-3 font-mono text-xs whitespace-pre-wrap text-subtext1">
                    {s.finishedAt === null ? "(step in progress…)" : s.output || "(no output)"}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
