# CONTINUITY — Yet Another Home Lab Manager

> Canonical project briefing. Read at session start.
> Stack: TypeScript (Node 22) + Fastify + React/Tailwind + PostgreSQL/Prisma
> Type: Web app (single-operator, passkey auth)

## [PLANS]

### Milestone 1: Foundation (In Progress)
Goal: Deployable app — passkey login, encrypted secrets, PVE/PBS + host registration, inventory view, full audit trail, Docker Compose deploy.
- [ ] Passkey (WebAuthn) auth for single operator
- [ ] Audit log (append-only; all mutations + external calls; UI viewer)
- [ ] Encrypted secrets store (AES-GCM, env MASTER_KEY, fail-loud without it)
- [ ] PVE/PBS node registration + per-node connection test
- [ ] Inventory sync (PVE guests/storage, PBS backup jobs)
- [ ] Guest host registration: master SSH keypair + bootstrap script; SSH executor
- [ ] App shell (branch feature/app-shell): themed sidebar shell, router, dashboard, production SPA serving

### Future Milestones
- M2 Monitoring: dashboards; liveness/service/guest-agent health checks; alerting
- M3 Updates: scheduling (host OS, guest OS, in-guest containers); reboot orchestration; post-update verification; email reports (external SMTP)
- M4 Backups: PBS status + stale alerts; automated restore testing (restore to scratch guest, verify boot)
- M5 Migration: cross-node container migration (dockermigrate-informed, reimplemented)

### Open Questions
- [ ] Minimal Proxmox API token privilege set (resolve during M1)
- [ ] Which PVE node hosts the app; self-update/reboot handling (before M3)
- [ ] Restore-test scratch guest placement (before M4)

## [DECISIONS]

- 2026-09-28: Initial stack — TypeScript/Node + Fastify + React/Tailwind + Postgres/Prisma; pnpm workspace; Biome; Vitest; Forgejo Actions; Docker Compose deploy.
- 2026-09-28: Deep-plan validated M1. Key decisions: HTTPS+hostname from operator's existing reverse proxy (passkeys require it); standard append-only audit log (hash-chain deferred); master SSH keypair + encrypted secrets store; passkey-only auth; dockermigrate is reference-only for M5.
- 2026-09-28: SSH now, agent later — executor must not leak SSH specifics.
- 2026-09-28: UI/UX guidelines set (docs/UI.md): dark dense console, sidebar nav growing with milestones, dashboard landing, 5-state status tokens, drawers + typed confirms, job center + toasts via SSE, desktop-first/usable-mobile.
- 2026-09-28: Theme — Catppuccin Mocha base, mauve accent. Decorative direction revised to 80s retro-terminal (Alien/MU-TH-UR: chamfered panels, phosphor glow, scanlines, uppercase micro-labels), NOT neon cyberpunk; confined to decorative surfaces. CSS-only animations, reduced-motion support (docs/UI.md §6).
- 2026-09-28: Proxmox access via API tokens where possible, SSH+CLI for gaps.

## [PROGRESS]

| Date | What was done |
|------|---------------|
| 2026-09-28 | Project scaffold: pnpm workspace (server + web), Fastify /health, React SPA shell, Prisma/Postgres, Biome, Vitest (all green), Dockerfile + compose, full doc set. Built server smoke-tested live (`/health` → ok). |
| 2026-09-28 | Started feature: App shell (no issue — Forgejo local-only) on branch feature/app-shell. |
|  |    ✓ Catppuccin Mocha + status tokens in Tailwind theme |
|  |    ✓ Router + sidebar shell + section placeholders |
|  |    ✓ Dashboard page (final M2 layout, modest content) |
|  |    ✓ Fastify serves built SPA in production |
|  |    ✓ Tests + full verification |

## [DISCOVERIES]

- 2026-09-28: Passkeys (WebAuthn) hard-require HTTPS + stable hostname — deployment must sit behind the operator's existing proxy/CA; RP_ID/ORIGIN env must match exactly (top M1 failure mode).
- 2026-09-28: MASTER_KEY loss = unrecoverable secrets; backup documented in .env.example; app refuses to start in production without it.
- 2026-09-28: Docker not available on the dev workstation — compose stack verified statically; runtime deploy verification must happen on the homelab.

## [OUTCOMES]

*None yet.*
