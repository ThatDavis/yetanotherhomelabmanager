# CONTINUITY — Yet Another Home Lab Manager

> Canonical project briefing. Read at session start.
> Stack: TypeScript (Node 22) + Fastify + React/Tailwind + PostgreSQL/Prisma
> Type: Web app (single-operator, passkey auth)

## [PLANS]

### Milestone 1: Foundation (Complete)
Goal: Deployable app — passkey login, encrypted secrets, PVE/PBS + host registration, inventory view, full audit trail, Docker Compose deploy.
- [x] Passkey (WebAuthn) auth for single operator
- [x] Audit log (append-only; all mutations + external calls; UI viewer)
- [x] Encrypted secrets store (AES-GCM, env MASTER_KEY, fail-loud without it)
- [x] Inventory sync (PVE guests/storage, PBS backup jobs)
- [x] Guest host registration: master SSH keypair + bootstrap script; SSH executor
- [x] App shell (branch feature/app-shell): themed sidebar shell, router, dashboard, production SPA serving

### Milestone 2: Monitoring (Complete)
Goal: Live status — ping checks, dashboards, health checks, alerting.
- [x] M2.1: Ping checks engine (targets, scheduler, state machine, dashboard panel)
- [x] M2.2: Live dashboard (cards + guest grid + status strip)
- [x] M2.3: Notifications (email + webhook on state change) (Issue #18, branch feature/18-notifications-state-change)

### Milestone 3: Updates (In Progress)
Goal: Scheduled updates with reboot orchestration, post-update verification, email reports.
- [x] M3.1: Update scheduling (Issue #20, branch feature/20-update-scheduling)
- [ ] M3.2: Reboot orchestration (Issue #22, branch feature/22-reboot-orchestration)

### Open Questions
- [ ] Minimal Proxmox API token privilege set (resolve during M1)
- [x] Which PVE node hosts the app — resolved 2026-10-01 by design: `self` flag on Host; reboot deferral in M3.2
- [ ] Restore-test scratch guest placement (before M4)

## [DECISIONS]

- 2026-10-01: Deep-plan validated M3.2 reboot orchestration. Key decisions: rolling reboots in Host.bootOrder sequence (boring strict order instead of a DAG — covers "X must come up first"); recovery gate = SSH reachable + health.check within 10 min before next host; abort roll on non-recovery, never re-touch rebooted hosts; UpdateSchedule.rebootAfterUpdate toggle drives auto-reboot after update jobs; manual per-host reboot via pre-flight-confirmed API; self host never auto-reboots (audited skip) and manual reboot refused (would kill the orchestrator). All work rides the M3.1 job engine.
- 2026-10-01: Deep-plan validated M3.1 update scheduling. Key decisions: PVE/PBS host OS updated via SSH (Proxmox API has no apt endpoint) — operator registers nodes as Hosts, no SSH fields on Node model; containers-in-guests included in M3.1 scope (docker compose projects only, standalone untouched); job engine (Job/JobStep + in-process runner + SSE/poll) is the core new primitive; schedules are weekly day(s)+time with OS/container toggles; per-host failure isolation + reboot-pending surfaced (reboot is M3.2); self-host open question resolved by `self` flag on Host.

- 2026-10-01: Deep-plan validated M2.3 notifications. Key decisions: DB-backed webhooks (editable without container restart) + Alerts UI section; per-target channel pick (email checkbox + webhook multi-select, m-n relation); node transitions alert via all enabled channels; SMTP creds stay in env (email enable flag is a DB setting); per-target notify default OFF; send failures audited as notify.fail, never affect check StepResult.ok.
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
| 2026-10-01 | Started Milestone 2: Monitoring. Started feature: Ping checks engine (Issue #14) on branch feature/14-ping-checks. |
|  |    ✓ PingTarget + CheckResult models |
|  |    ✓ ping executor + ping.check step (alertAfter state machine) |
|  |    ✓ In-process scheduler + retention pruning |
|  |    ✓ Targets CRUD API (audited) |
|  |    ✓ Dashboard targets panel |
|  |    ✓ Tests + scheduler verification |
| 2026-10-01 | Completed feature: Ping checks engine (M2.1, PR #15). DoD all PASS; scheduler verified live. |
| 2026-10-01 | Started feature: Live dashboard (M2.2, Issue #16) on branch feature/16-live-dashboard. |
|  |    ✓ Node status fields + nodeTest recording |
|  |    ✓ Scheduler node checks (5 min) |
|  |    ✓ GET /api/dashboard aggregation |
|  |    ✓ Cards + liveness + activity + strip grid |
|  |    ✓ Sidebar chip live |
|  |    ✓ Tests + browser verification |
| 2026-10-01 | Completed feature: Live dashboard + Uptime tab (M2.2, PR #17). DoD all PASS; browser-verified dashboard/tab/modal. |
| 2026-10-01 | Started feature: Notifications on state change (M2.3, Issue #18) on branch feature/18-notifications-state-change. Deep-plan validated: DB webhooks + Alerts UI, per-target channel pick, node transitions via all enabled channels, SMTP creds in env. |
|  |    ✓ Schema: Webhook + Setting models, PingTarget notify/notifyEmail + m-n webhooks; migration |
|  |    ✓ notify module: email (nodemailer) + webhook (fetch), audited, never throws |
|  |    ✓ Transition hooks: pingCheck (per-target routing) + nodeTest (all enabled channels) |
|  |    ✓ API: webhooks CRUD + test-send; targets accept channel fields |
|  |    ✓ UI: Alerts page (email toggle + webhook CRUD), Uptime form channel pick |
|  |    ✓ Tests + docs (.env.example, SPEC.md, PLAN.md) |
| 2026-10-01 | Completed feature: Notifications on state change (M2.3, PR #19). DoD all PASS (server 56/56, web 12/12); browser-verified + live-restarted on local server. Milestone 2 complete. |
| 2026-10-01 | Started Milestone 3: Updates. Started feature: Update scheduling (M3.1, Issue #20) on branch feature/20-update-scheduling. Deep-plan validated: PVE/PBS updated via SSH-as-Host, compose-only containers, job engine is core new primitive. |
|  |    ✓ Schema: UpdateSchedule + Job + JobStep models, Host.self flag, migration |
|  |    ✓ Steps: os.update (apt/dnf detect, reboot-pending) + container.update (compose projects), mocked-executor tests |
|  |    ✓ Job runner: persistent execution, per-host serialization, continue-on-failure, SSE endpoint |
|  |    ✓ Scheduler + API: auto-trigger weekly schedules, run-now with pre-flight, schedule CRUD |
|  |    ✓ UI: Updates page (schedule editor + pre-flight) + job center live status |
|  |    ✓ Built: UpdateSchedule/Job/JobStep models (+Host.self); updates.ts (os.update apt/dnf + reboot probe, container.update compose-only); jobs.ts runner (serial queue, continue-on-failure, deleted-mid-job guard, per-job + global SSE); schedules API + weekly scheduler tick; Updates page, Jobs job center, toasts (server 74/74, web 12/12); browser-verified full flow incl. live SSE step + toast |
| 2026-10-01 | Completed feature: Update scheduling (M3.1, PR #21). DoD all PASS (1 WARN: no web component tests for new pages, matches convention); live browser verification; real-host run pending on homelab. |
| 2026-10-01 | Started feature: Reboot orchestration (M3.2, Issue #22) on branch feature/22-reboot-orchestration. Deep-plan validated: bootOrder rolling with recovery gate, abort on non-recovery, self-host refused. |
|  |    ✓ Schema: Host.bootOrder, UpdateSchedule.rebootAfterUpdate, migration |
|  |    ✓ host.reboot step (send + poll recovery w/ health.check, 10-min timeout), mocked tests |
|  |    ✓ Reboot rolls in jobs.ts (bootOrder sort, recovery gate, abort on failure, self skip) + manual reboot job |
|  |    ✓ API: schedule toggle, POST /api/hosts/:id/reboot (self refused), hosts PATCH bootOrder |
|  |    ✓ UI: schedule toggle, Guests bootOrder + REBOOT typed-confirm, job center reboot steps |
|  |    ✓ Built: Host.bootOrder + UpdateSchedule.rebootAfterUpdate + Job.kind/_HostToJob (+JobStep.finishedAt/ok default for running rows); host.reboot step (send + 10-min recovery poll via health.check); rolling rolls low→high bootOrder with abort-on-non-recovery; self host auto-skip (audited) + manual refusal (409); Guests EDIT drawer (notes/self/bootOrder) + typed-confirm REBOOT modal; browser-verified incl. live running-step rows (server 83/83, web 12/12) |

## [DISCOVERIES]

- 2026-10-01: CI runs `biome check .` from the repo root (85 files, stricter than per-package runs) — it flagged useExhaustiveDependencies errors that `biome check src` inside web/ did not surface. Always run lint from the repo root before pushing; the DoD lint step must use `biome check .`.

- 2026-09-28: Passkeys (WebAuthn) hard-require HTTPS + stable hostname — deployment must sit behind the operator's existing proxy/CA; RP_ID/ORIGIN env must match exactly (top M1 failure mode).
- 2026-09-28: MASTER_KEY loss = unrecoverable secrets; backup documented in .env.example; app refuses to start in production without it.
- 2026-09-28: Docker not available on the dev workstation — compose stack verified statically; runtime deploy verification must happen on the homelab.
- 2026-10-01: zod `.partial()` on a schema with `.default()` fields re-applies the defaults to omitted keys — PATCH {enabled:false} silently wiped webhook names, and target PATCH reset intervalSec/alertAfter/enabled. Update schemas must be plain optionals. Regression-pinned in notify/ping tests.
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

### Ping checks engine (M2.1, 2026-10-01)
- Manual ping targets with per-target interval + alertAfter; in-process staggered scheduler; state machine with audited transitions; dashboard management panel. Live-verified scheduling; fixed deleted-mid-check race and clip-path drawer trap (portal).

### Live dashboard + Uptime tab (M2.2, 2026-10-01)
- Dashboard went live: summary cards, node liveness (scheduler-driven node tests), recent activity, target strips; config split into the Uptime tab (uptime %, detail modal with SVG latency graph); sidebar chip now real worst-status. Immediately surfaced a real signal (defiant DOWN).

### Update scheduling (M3.1, 2026-10-01)
- Weekly update schedules (day(s)+time, host scope, separate OS/container toggles) firing as persistent background jobs via a serial in-process runner (Job/JobStep DB rows); per-host failure isolation; per-job + global SSE; job center UI with live status, pre-flight summary before manual runs, completion toasts.
- `os.update` step: apt/dnf/yum auto-detect over SSH, noninteractive with conffiles-kept, 30-min timeout, reboot-pending probe (deferred to M3.2). `container.update`: docker compose projects only, standalone untouched.
- `Host.self` flag resolves the self-host open question by design. Fixed live-found bug: os.update masked SSH connection failures as "no package manager" (regression-pinned). Browser-verified end-to-end (PR #21).

### Notifications on state change (M2.3, 2026-10-01)
- Exactly one alert per transition (target down/recovery, node down/up) to email (env SMTP, nodemailer) and/or DB-backed webhooks (JSON POST, editable without restart, per-target channel pick). Sends audited (notify.send/fail), never affect checks; unknown→up first-check is audited but not alerted. Fixed pre-existing zod .partial() defaults-wipe-on-PATCH bug (regression-pinned). Browser-verified; closes Milestone 2.
