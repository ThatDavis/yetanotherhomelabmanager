# Architecture — Home Lab Manager

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
| CI/CD | Forgejo Actions | Matches repo host |

## Project Structure

```
.
├── server/                 # @hlm/server — Fastify API
│   ├── src/
│   │   ├── app.ts          #   server factory (testable via app.inject)
│   │   └── index.ts        #   entry: env validation, listen
│   ├── prisma/schema.prisma
│   └── test/
├── web/                    # @hlm/web — React SPA
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
