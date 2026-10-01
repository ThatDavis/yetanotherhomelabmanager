# Specification — Yet Another Home Lab Manager

> Last updated: 2026-10-01

## Overview

Yet Another Home Lab Manager (YAHLM) is a single-operator web application for managing a Proxmox-based homelab: two PVE nodes (one offsite, reached over WireGuard/Tailscale) plus a separate PBS host, running a mix of Debian, RHEL, and other Linux guests. It provides inventory, monitoring, scheduled updates with post-update verification and email reports, PBS backup oversight with automated restore testing, and cross-node container migration. Security and auditing are core: passkey-only auth, secrets encrypted at rest, and an audit trail on every action. It is ansible-like but deliberately narrower in scope; host access is SSH now, with a lightweight agent as a possible later addition.

## Milestone 1 — Foundation

### Features

#### Feature: Passkey authentication
**Description:** Single operator registers a passkey (WebAuthn) and logs in/out. No password flow. RP_ID and ORIGIN are env-configured to match the reverse-proxy hostname.
**Acceptance Criteria:**
- [ ] Operator can register a passkey through the HTTPS proxy
- [ ] Operator can log in and log out; unauthenticated requests to protected routes are rejected
- [ ] WebAuthn RP ID/origin mismatch fails loudly with a clear error, not a silent browser failure

#### Feature: Audit log
**Description:** Append-only record of every mutating action and every external call (PVE/PBS API, SSH): actor, action, target, timestamp, result (incl. error text on failure).
**Acceptance Criteria:**
- [ ] Every mutating API route writes an audit entry
- [ ] Failed external calls produce entries including the error
- [ ] Entries are viewable in the UI, newest first

#### Feature: Encrypted secrets store
**Description:** API tokens, SSH private key, and SMTP password are AES-GCM encrypted at rest with an env-supplied MASTER_KEY.
**Acceptance Criteria:**
- [ ] Secrets in the database are ciphertext (verifiable by inspecting rows)
- [ ] App refuses to start in production without MASTER_KEY
- [ ] MASTER_KEY backup requirement documented (README/.env.example)

#### Feature: PVE/PBS node registration + connection test
**Description:** Register Proxmox VE and Proxmox Backup Server nodes by URL + API token (secret encrypted at rest). "Test connection" verifies auth and required privileges; TLS uses TOFU fingerprint pinning.
**Acceptance Criteria:**
- [x] Node can be added, edited, removed (token secret redacted from API responses and audit params)
- [x] Test connection reports success/failure with the underlying error; TOFU pins cert fingerprint on first connect, mismatch hard-fails, unpin endpoint re-trusts
- [x] 401 (bad token) and 403 (insufficient privileges) surface distinctly, with a privilege hint (PVEAuditor / Datastore.Audit)

#### Feature: Inventory sync
**Description:** On demand (and later on a schedule), pull VMs, LXCs, and storage from PVE nodes; backup jobs (vzdump, PVE-side) and PBS datastore summaries. Display in the UI.
**Acceptance Criteria:**
- [x] Inventory lists guests with node, type, VMID, name, status
- [x] PVE backup jobs summarized (count, enabled); PBS datastores with snapshot counts and latest backup time
- [x] Sync failures are per-node (one bad node doesn't blank the rest) and audited

#### Feature: Guest host registration + SSH executor
**Description:** Tool generates a master SSH keypair (private key stored encrypted) and emits a bootstrap script the operator runs once per host to install the public key. The SSH executor runs steps on registered hosts under the step contract (docs/ARCHITECTURE.md §Design Principles).
**Acceptance Criteria:**
- [x] Keypair generated once; public key installable via per-host bootstrap script (idempotent, sh-compatible)
- [x] Fixed `health.check` probe runs on a registered host; combined tagged output stream and exit code returned and audited (no raw exec endpoint — principle 9)
- [x] sh-compatible only; no distro-specific assumptions (Debian/RHEL/busybox)

#### Feature: Deployable app shell
**Description:** React SPA served by the Fastify server; Docker Compose stack (app + Postgres) with automatic Prisma migrations; plain HTTP behind the operator's existing reverse proxy/CA.
**Acceptance Criteria:**
- [ ] `docker compose up -d --build` starts the stack; migrations apply automatically
- [ ] SPA loads through the proxy and can complete passkey login
- [ ] CI green: vitest, biome check, prisma validate, production build

---

## Milestone 2 — Monitoring

#### Feature: Notifications on state change (M2.3)
**Description:** One notification per status transition — ping targets DOWN (after alertAfter) and UP recovery, node liveness DOWN/UP. Channels: email via env-configured SMTP relay and DB-backed webhooks (editable without container restart). Per-target channel pick; node transitions go to all enabled channels.
**Acceptance Criteria:**
- [x] Target DOWN sends one alert (after alertAfter threshold), UP sends one recovery — exactly once per transition
- [x] Node liveness DOWN/UP transitions notify via all enabled channels
- [x] Webhooks managed in the Alerts UI (add/edit/remove/enable/test); SMTP creds in env, email channel toggled in UI
- [x] Per-target: notify on/off (default off), email checkbox, webhook multi-select
- [x] Send failures are audited (notify.fail) and never affect check results or crash the scheduler
- [x] No channel configured/enabled → zero sends (fail-safe default)
- [x] Every send is audit-logged; tests green (SMTP via mock transport, webhook via local HTTP capture)

---

## Milestone 3 — Updates

#### Feature: Update scheduling (M3.1)
**Description:** Operator defines update schedules (weekly day(s) + time) scoped to registered hosts — including PVE/PBS nodes registered as SSH hosts for this purpose. A scheduler triggers jobs automatically; manual run-now is available behind a pre-flight summary. Jobs run as background jobs with live status, per-step audit, and per-host failure isolation. Covers OS updates (apt/dnf auto-detected) and Docker container updates (compose projects). Reboot orchestration (M3.2), post-update verification (M3.3), and email reports (M3.4) build on this job engine.
**Acceptance Criteria:**
- [ ] Schedule CRUD: weekly day(s)-of-week + time, host scope multi-select, separate toggles for OS updates and container updates, enabled flag
- [ ] Scheduler auto-triggers jobs at the scheduled time; manual "run now" gated by a pre-flight summary (what will happen, on which targets — UI.md §5)
- [ ] `os.update` auto-detects package manager (apt/dnf), applies updates, returns combined tagged output; failure on one host does not stop the job
- [ ] `container.update` updates Docker Compose projects on scoped hosts; standalone containers are listed but untouched
- [ ] Job engine: persistent Job/JobStep records, job-center UI per UI.md §5, live status via SSE (poll fallback), toast on completion/failure
- [ ] Reboot-pending is surfaced per host in job results (reboot-required flag / needs-restarting) — reboot itself is M3.2
- [ ] `self` flag on Host marks the host that runs the app; UI warns that its reboot is deferred to M3.2 (resolves the self-host open question by design: works either way)
- [ ] Every job and step is audited via the existing step contract
- [ ] Tests green (steps via mocked executor, scheduler trigger, API)

---

## Future Milestones

- **M2 — Monitoring:** PVE/PBS dashboards; health checks (liveness, service endpoints, guest agent); alerting.
- **M3 — Updates:** scheduled updates for hosts/guests/containers; reboot orchestration; post-update health verification; email reports via external SMTP relay.
- **M4 — Backups:** PBS job status + stale-backup alerts; automated restore testing (restore to a scratch guest, verify boot).
- **M5 — Migration:** cross-node container migration between VMs, informed by dockermigrate's approach (SSH + rsync, dry-run, rollback), reimplemented in this codebase.

Full acceptance criteria will be defined when each milestone starts.

## Non-Functional Requirements

- Passkey-only auth; secrets AES-GCM encrypted at rest; audit trail on every action
- Responsive UI; long operations as background jobs with live status
- Scale from 2 nodes upward; offsite node over VPN
- Mixed guest distros (Debian, RHEL, others) — nothing distro-specific without abstraction

## Open Questions

- [ ] Exact Proxmox API token minimal privilege set per feature — Owner: operator, Due: M1 implementation
- [x] Which PVE node hosts the app itself — resolved 2026-10-01 by design: `self` flag on Host marks the app host; reboot deferral lands in M3.2 (works whether the app lives on a PVE node or not)
- [ ] Tamper-evidence (hash-chained audit log) deferred — revisit if threat model changes — Due: TBD
