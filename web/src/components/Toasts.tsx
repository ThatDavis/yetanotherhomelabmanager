import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";

// Global job-completion toasts (docs/UI.md §5: toast regardless of current
// page, links to the job). Fed by the server-wide job event stream.

type Toast = { id: number; kind: "ok" | "error"; text: string; jobId: string };

const ToastContext = createContext<(toast: Omit<Toast, "id">) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = nextId.current++;
    setToasts((ts) => [...ts, { ...toast, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 10_000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`chamfer border-0 px-4 py-3 [--chamfer-line:var(--color-surface1)] ${
              t.kind === "ok"
                ? "[--chamfer-bg:color-mix(in_oklab,var(--color-status-ok)_12%,var(--color-mantle))]"
                : "[--chamfer-bg:color-mix(in_oklab,var(--color-status-error)_12%,var(--color-mantle))]"
            }`}
          >
            <div
              className={`micro-label mb-1 ${t.kind === "ok" ? "text-status-ok" : "text-status-error"}`}
            >
              {t.kind === "ok" ? "▚ JOB COMPLETE" : "▚ JOB FAILED"}
            </div>
            <Link
              to={`/jobs?job=${t.jobId}`}
              className="font-mono text-sm text-text hover:underline"
            >
              {t.text}
            </Link>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// Server-wide job stream → toast on terminal status. Mounted once in AppShell.
export function JobToastListener() {
  const toast = useToast();

  useEffect(() => {
    const source = new EventSource("/api/jobs/events");
    source.onmessage = null;
    source.addEventListener("status", (raw) => {
      const data = JSON.parse((raw as MessageEvent).data) as {
        jobId?: string;
        status?: string;
      };
      if (!data.jobId || (data.status !== "succeeded" && data.status !== "failed")) return;
      toast({
        kind: data.status === "succeeded" ? "ok" : "error",
        text: `job ${data.jobId.slice(0, 8)} ${data.status}`,
        jobId: data.jobId,
      });
    });
    return () => source.close();
  }, [toast]);

  return null;
}
