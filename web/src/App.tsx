import { useEffect, useState } from "react";

type Health = { status: string; service: string };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setHealth)
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 text-slate-100">
      <h1 className="text-4xl font-bold tracking-tight">Home Lab Manager</h1>
      <p className="mt-2 text-slate-400">Manage, monitor, and automate your homelab.</p>
      <div className="mt-6 rounded-lg border border-slate-800 bg-slate-900 px-4 py-3 font-mono text-sm">
        {error && <span className="text-red-400">API unreachable: {error}</span>}
        {!error && !health && <span className="text-slate-500">Contacting API…</span>}
        {health && (
          <span className="text-emerald-400">
            API {health.status} — {health.service}
          </span>
        )}
      </div>
    </main>
  );
}
