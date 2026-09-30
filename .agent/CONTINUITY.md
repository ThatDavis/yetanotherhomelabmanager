# CONTINUITY — Yet Another Home Lab Manager

> Canonical project briefing. Read at session start.
> Stack: TypeScript (Node 22) + Fastify + React/Tailwind + PostgreSQL/Prisma
> Type: Web app (single-operator, passkey auth)

## [PLANS]

### Milestone 1: Foundation (In Progress)
Goal: Deployable app — passkey login, encrypted secrets, PVE/PBS + host registration, inventory view, full audit trail, Docker Compose deploy.
- [x] Passkey (WebAuthn) auth for single operator
- [x] Audit log (append-only; all mutations + external calls; UI viewer)
- [x] Encrypted secrets store (AES-GCM, env MASTER_KEY, fail-loud without it)
- [x] Inventory sync (PVE guests/storage, PBS backup jobs)
- [x] Guest host registration: master SSH keypair + bootstrap script; SSH executor
- [x] App shell (branch feature/app-shell): themed sidebar shell, router, dashboard, production SPA serving

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
- 2026-09-29: Project renamed to Yet Another Home Lab Manager (YAHLM); remote moved to GitHub (github.com/ThatDavis/yetanotherhomelabmanager); CI moved from Forgejo Actions to GitHub Actions.
- 2026-09-29: Design principles adopted (docs/ARCHITECTURE.md): step contract `(ctx, params) → StepResult`; ok-boolean for expected failures + throw for bugs; combined tagged output stream; noun.verb step names; composition in TS only (no DSL); no raw exec API endpoint; primitives need ≥2 consumers.

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
| 2026-09-29 | Completed feature: App shell. DoD: build/test/lint/secrets PASS; README updated. Chamfered rim borders (two-layer clip-path, 2px) settled after 3 iterations. |
| 2026-09-30 | Started feature: Guest host registration + SSH executor (Issue #2) on branch feature/2-guest-host-ssh-executor. |
|  |    ✓ Prisma Host + AuditEntry + Secret models, initial migration |
|  |    ✓ crypto module (AES-GCM) + minimal secrets store |
|  |    ✓ Master keypair generation + bootstrap script |
|  |    ✓ SSH executor + step contract + health.check probe |
|  |    ✓ API: hosts CRUD + probe + bootstrap + audit read |
|  |    ✓ Guests page UI (table, register drawer, bootstrap viewer, probe terminal) |
| 2026-09-30 | Completed feature: Guest host registration + SSH executor (PR #3). DoD all PASS; end-to-end verified against podman sshd. |
| 2026-09-30 | Started feature: PVE/PBS node registration + connection test (Issue #4) on branch feature/4-pve-pbs-node-registration. |
|  |    ✓ Prisma Node model + migration |
|  |    ✓ Proxmox API client (token auth, TOFU TLS pinning) |
|  |    ✓ node.test step (version + privilege probe) |
|  |    ✓ API: nodes CRUD + test + unpin (token encrypted) |
|  |    ✓ Nodes page UI |
|  |    ✓ Tests + verification (real-TLS mock PVE server) |
| 2026-09-30 | Completed feature: PVE/PBS node registration + connection test (PR #5). DoD all PASS; TOFU lifecycle verified against real-TLS mock. |
| 2026-09-30 | Started feature: Inventory sync (Issue #6) on branch feature/6-inventory-sync. |
|  |    ✓ Prisma Guest model + migration |
|  |    ✓ node.sync step (PVE resources + jobs, PBS datastores) |
|  |    ✓ POST /api/sync + GET /api/guests + per-node sync |
|  |    ✓ Guests page: PVE inventory panel + SYNC button |
|  |    ✓ Nodes page: sync action + result drawer |

|  |    ✓ Tests (two-node mock, per-node isolation, prune, PBS) |
| 2026-09-30 | Completed feature: Inventory sync (PR #7). DoD all PASS; verified against real PVE+PBS (green TEST/SYNC, real guests listed). TLS session-resumption fingerprint bug found + fixed via live testing. |
| 2026-09-30 | Started feature: Passkey authentication (Issue #8) on branch feature/8-passkey-auth. |
|  |    ✓ Prisma Credential + Session models |
|  |    ✓ Auth module (sessions, RP config, guard) + routes (register/login/logout/status/credentials) |
|  |    ✓ Open first-run registration; additional passkeys authenticated |
|  |    ✓ Themed login page + 401 redirect + logout |
|  |    ✓ Settings passkey management |
|  |    ✓ Tests + full ceremony verification (virtual authenticator) |
| 2026-09-30 | Completed feature: Passkey authentication (PR #9). DoD all PASS; full ceremony verified with virtual authenticator + operator's real passkey registered. |
| 2026-09-30 | Started feature: Audit log viewer (Issue #10) on branch feature/10-audit-log-viewer. |
|  |    ✓ GET /api/audit: filters + cursor pagination |
|  |    ✓ Audit page UI (table, filters, expandable rows) |
|  |    ✓ Coverage: auth.logout audited |
|  |    ✓ Tests (filters, pagination) |
|  |    ✓ Browser verification with real data |
| 2026-09-30 | Completed feature: Audit log viewer (PR #11). DoD all PASS; browser-verified with real data. |
| 2026-09-30 | Started feature: Secrets management (Issue #12) on branch feature/12-secrets-management. |
|  |    ✓ crypto: explicit-key support |
|  |    ✓ secrets module: list, guarded delete, rotateMasterKey (oldKey param) |
|  |    ✓ API: list, rotate-key, guarded delete (audited) |
|  |    ✓ Settings SECRETS panel (typed-confirm rotation) |
|  |    ✓ Tests + rotation mutex + serial test pool |
| 2026-09-30 | Completed feature: Secrets management (PR #13). DoD all PASS; container deployment verified end-to-end (podman). |

## [DISCOVERIES]

- 2026-09-28: Passkeys (WebAuthn) hard-require HTTPS + stable hostname — deployment must sit behind the operator's existing proxy/CA; RP_ID/ORIGIN env must match exactly (top M1 failure mode).
- 2026-09-28: MASTER_KEY loss = unrecoverable secrets; backup documented in .env.example; app refuses to start in production without it.
- 2026-09-28: Docker not available on the dev workstation — compose stack verified statically; runtime deploy verification must happen on the homelab.
- 2026-09-30: Node TLS session resumption returns empty peer certificates — any fingerprint pinning must disable session caching (maxCachedSessions: 0).
- 2026-09-30: PVE permissions: /api2/json/nodes works with minimal perms, but /cluster/resources needs the ACL on path "/" — and with Privilege Separation ON, the token needs its OWN ACL entry (user perms don't flow). PVEAuditor on / covers sync.
- 2026-09-30: Virtual authenticators (CDP) don't persist credentials across browser tabs — WebAuthn e2e must run register+login in one tab session. Test DB cleanup must be scoped to test-created rows once real operator data exists.
- 2026-09-30: rotateMasterKey originally decrypted only with the current env key — rotating BACK was impossible; combined with prefix-based test cleanup and parallel vitest workers on one dev DB, this stranded real secrets repeatedly. Fixed with oldKeyHex param + mutex + singleFork pool + scoped cleanup. Never export MASTER_KEY into the interactive shell (test env.ts prefers inherited vars).

## [OUTCOMES]

### App shell (2026-09-29)
- Catppuccin Mocha themed shell (YAHLM wordmark), sidebar nav for M1 sections, dashboard with empty-state CTA, react-router, Fastify serves built SPA with client-route fallback; 7 tests green; verified live + in browser.

### Guest host registration + SSH executor (2026-09-30)
- Host CRUD + master ed25519 keypair (encrypted at rest) + idempotent bootstrap script; SSH executor with combined tagged stream; step contract with mandatory audit (health.check probe); pulled forward minimal crypto + audit writer. Verified end-to-end on podman sshd; 19/19 tests.

### PVE/PBS node registration + connection test (2026-09-30)

- Node CRUD with encrypted API tokens; Proxmox client with TOFU fingerprint pinning (pin/mismatch/unpin); node.test step with version + privilege probes; real-TLS mock test suite. Verified against real Proxmox 2026-09-30.

### Inventory sync (2026-09-30)

- Guest persistence (upsert+prune), PVE storage/jobs summary, PBS datastore summaries; per-node failure isolation; node EDIT drawer; default-port-by-type. Verified green against real PVE + PBS. Two live-found bugs fixed: TLS session-resumption empty-cert mismatch, node.sync skipping TOFU verification.

### Audit log viewer (2026-09-30)
- Filterable/paginated audit read API + dense Audit page with expandable output/params; auth.logout coverage gap closed. Verified in browser with real homelab audit data.

### Passkey authentication (2026-09-30)
- WebAuthn ceremonies via SimpleWebAuthn; DB sessions (30d, revocable); open first-run registration then closed; themed login page; Settings passkey management; /api/* guarded. Verified end-to-end in Chromium (virtual authenticator) and with the operator's real passkey. Gotcha recorded: test cleanup must never delete operator credentials.

### Secrets management (2026-09-30)
- Secrets list (metadata only), guarded delete, master key rotation with typed-confirm UI; rotateMasterKey redesigned with oldKeyHex + mutex after the rotate-back-impossible bug stranded secrets; test suite serialized (singleFork) after repeated cross-worker DB races. Container deployment verified end-to-end via podman.
