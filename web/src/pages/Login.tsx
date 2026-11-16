import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";

// Login is a decorative surface (docs/UI.md §6) — full retro-terminal treatment.
type Status = { registered: boolean; authenticated: boolean } | null;

export function Login() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ registered: boolean; authenticated: boolean }>("/auth/status")
      .then((s) => {
        if (s.authenticated) navigate("/");
        else setStatus(s);
      })
      .catch(() => setError("server unreachable"));
  }, [navigate]);

  const run = async (kind: "register" | "login") => {
    setBusy(true);
    setError(null);
    try {
      const { challengeKey, ...options } = await api<
        { challengeKey: string } & Record<string, unknown>
      >(`/auth/${kind}/options`, { method: "POST" });

      const response =
        kind === "register"
          ? await startRegistration({
              optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
            })
          : await startAuthentication({
              optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
            });

      await api<unknown>(`/auth/${kind}/verify`, {
        method: "POST",
        body: JSON.stringify({ challengeKey, response }),
      });
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
