import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

// Login is a decorative surface (docs/UI.md §6) — full retro-terminal treatment.
type Status = { registered: boolean; authenticated: boolean } | null;

export function Login() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((s: { registered: boolean; authenticated: boolean }) => {
        if (s.authenticated) navigate("/");
        else setStatus(s);
      })
      .catch(() => setError("server unreachable"));
  }, [navigate]);

  const run = async (kind: "register" | "login") => {
    setBusy(true);
    setError(null);
    try {
      const optRes = await fetch(`/api/auth/${kind}/options`, { method: "POST" });
      if (!optRes.ok) throw new Error((await optRes.json()).error ?? `HTTP ${optRes.status}`);
      const { challengeKey, ...options } = await optRes.json();

      const response =
        kind === "register"
          ? await startRegistration({ optionsJSON: options })
          : await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch(`/api/auth/${kind}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeKey, response }),
      });
      if (!verifyRes.ok)
        throw new Error((await verifyRes.json()).error ?? `HTTP ${verifyRes.status}`);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "ceremony failed");
      setBusy(false);
    }
  };

  return (
    <main className="scanlines flex min-h-screen flex-col items-center justify-center bg-crust">
      <div className="chamfer w-full max-w-sm border-0 bg-transparent p-8 [--chamfer-line:var(--color-surface1)] [--chamfer-bg:var(--color-base)]">
        <div className="phosphor mb-1 font-mono text-2xl font-bold tracking-widest text-accent">
          YAHLM<span className="animate-blink">▮</span>
        </div>
        <div className="micro-label mb-6">YET ANOTHER HOME LAB MANAGER</div>

        <pre className="mb-6 font-mono text-xs leading-relaxed text-subtext0">
          {">"} SYS.BOOT ............ OK{"\n"}
          {">"} SEC.MODULE .......... ARMED{"\n"}
          {">"} OPERATOR AUTH .......{" "}
          {status ? (status.registered ? "REQUIRED" : "FIRST RUN") : "…"}
        </pre>

        {error && <p className="mb-4 font-mono text-sm text-status-error">! {error}</p>}

        {status && !status.registered && (
          <>
            <p className="mb-4 font-mono text-xs text-subtext0">
              No passkey registered. First-run registration is open — it closes once the first
              passkey exists.
            </p>
            <button
              type="button"
              onClick={() => run("register")}
              disabled={busy}
              className="chamfer chamfer-accent w-full px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))] disabled:opacity-50"
            >
              {busy ? "WAITING FOR AUTHENTICATOR…" : "⚿ REGISTER FIRST PASSKEY"}
            </button>
          </>
        )}

        {status?.registered && (
          <button
            type="button"
            onClick={() => run("login")}
            disabled={busy}
            className="chamfer chamfer-accent w-full px-4 py-2 font-mono text-sm text-accent [--chamfer-bg:color-mix(in_oklab,var(--color-accent)_10%,var(--color-mantle))] hover:[--chamfer-bg:color-mix(in_oklab,var(--color-accent)_20%,var(--color-mantle))] disabled:opacity-50"
          >
            {busy ? "WAITING FOR AUTHENTICATOR…" : "⚿ AUTHENTICATE"}
          </button>
        )}
      </div>
    </main>
  );
}
