# Architecture — Yet Another Home Lab Manager

> Last updated: 2026-09-28

## Stack Decisions

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | TypeScript (Node 22) | Fast web iteration; operator already strong in Rust but chose TS for UI velocity |
| Backend | Fastify | Mature, low ceremony, JSON-schema validation built in |
| Frontend | React SPA (Vite) | Biggest ecosystem for monitoring/dashboard UIs |
| CSS | Tailwind CSS v4 | Utility-first, fast iteration |
| Database | PostgreSQL | Room to grow beyond single-operator scale |
| ORM | Prisma | Polished DX, migrations, Postgres support |
| Auth | Passkeys (WebAuthn) | Phishing-resistant, no password store; requires HTTPS origin |
| Secrets at rest | AES-GCM, env MASTER_KEY | Simple, auditable; key backup documented |
| Host access | SSH (master keypair) now; agent optional later | Zero host footprint to start |
| Proxmox access | PVE/PBS REST API (tokens) where possible, SSH+CLI for gaps | Structured + least-privilege first |
| Testing | Vitest | Standard with Vite, fast |
| Lint/Format | Biome | One tool, one config |
| Package manager | pnpm workspace (`server/`, `web/`) | Strict, fast, disk-efficient |
| Hosting | Docker Compose behind existing reverse proxy/CA | Homelab-native; proxy supplies TLS+hostname for passkeys |
| CI/CD | GitHub Actions | Repo hosted on GitHub |

## Project Structure

```
.
├── server/                 # @yahlm/server — Fastify API
│   ├── src/
│   │   ├── app.ts          #   server factory (testable via app.inject)
│   │   └── index.ts        #   entry: env validation, listen
│   ├── prisma/schema.prisma
│   └── test/
├── web/                    # @yahlm/web — React SPA
│   ├── src/                #   App.tsx, main.tsx, index.css
│   ├── vite.config.ts      #   dev proxy: /api → :3000
│   └── test/
├── docs/                   # SPEC.md, ARCHITECTURE.md, adr/
├── .agent/CONTINUITY.md    # canonical briefing
├── Dockerfile              # multi-stage; runtime runs migrate deploy then node
└── docker-compose.yml      # app + postgres (healthcheck-gated)
```

**Conventions:**
- API routes under `/api` semantics; Vite dev server proxies `/api/*` → Fastify `:3000` (prefix stripped)
- Production: Fastify serves the built SPA from `web/dist` and the API together
- `buildServer()` factory pattern so tests use `app.inject` without listening
- Migrations always via `prisma migrate deploy` at container start — never `db push` in prod
- UI patterns (shell, status tokens, jobs, drawers) follow `docs/UI.md` — amend the doc, never drift per-screen

## Design Principles (unix-philosophy bias)

Adopted 2026-09-29 as a *bias, not an architecture*. The domain is already unix-shaped (SSH, apt, rsync, systemctl); M3–M5 are the same problem (compose steps over SSH, stream output, verify, record). These rules steer the executor and all automation work.

1. **Steps, not scripts.** Every operation on infrastructure is a *step*: one TypeScript function, one responsibility.
2. **Uniform contract.** Every step: `(ctx, params) → Promise<StepResult>`. `ctx` carries target, executor, and audit handle.
3. **Failure model.** Expected failures (nonzero exit, timeout, unreachable host) return `{ ok: false, output }`. Bugs and invariant violations throw. Never swallow either into the other.
4. **Streams for humans, JSON for machines.** Command output is one interleaved stream, lines tagged stdout/stderr (like `docker logs`), rendered verbatim in the UI. Structured data flows between steps as JSON — code never parses human output.
5. **Composition in code.** Workflows (update orchestration, restore testing, migration) are async functions awaiting steps in order. No pipeline DSL, no config-driven composition — ever.
6. **Everything recorded.** A step cannot run without an audit entry: dotted name, target, params (secrets redacted), result, duration, output.
7. **noun.verb naming.** Canonical step names are dotted strings (`guest.snapshot`, `os.update`, `health.check`) used in audit log and job UI; function names map directly.
8. **Primitives earn existence.** A step is extracted only when two workflows need it or it's independently useful; otherwise it stays inline in the workflow.
9. **No raw exec endpoint.** The API exposes workflows and safe probes (health check, connection test) — never arbitrary command execution. Audited or not, a raw exec endpoint is one XSS away from root on every host.
10. **CLI-shaped API.** Noun-verb, JSON-only endpoints so a future CLI is a thin wrapper. No CLI until someone feels the itch.

## Key Design Decisions

- 2026-09-28: **SSH now, agent later.** Executor abstraction must not leak SSH specifics so a future agent transport slots in.
- 2026-09-28: **dockermigrate is reference-only.** Migration logic (SSH+rsync, dry-run, plan review, rollback) will be reimplemented in M5, not wrapped or ported.
- 2026-09-28: **Standard append-only audit log**, not hash-chained. Tamper-evidence deferred; revisit if threat model changes.
- 2026-09-28: **Master SSH keypair + encrypted secrets store** over per-host keys. One keypair, bootstrap script per host.
- 2026-09-28: **TLS/hostname supplied by operator's existing reverse proxy.** App serves plain HTTP; RP_ID/ORIGIN env must match public origin.

## Architecture Decision Records

- `docs/adr/` — *No ADRs yet.* Run `/dev:file-adr` for significant design choices.

## Open Design Questions

- Self-host node: which PVE node runs the app, and how update orchestration (M3) handles rebooting its own host
- Restore-testing (M4) resource placement: which node/storage hosts scratch guests

## Reference

- [dockermigrate](https://codeberg.org/ThatNaysayer/dockermigrate) — prior art for container migration patterns (dry-run, plan review, per-destination rollback)
