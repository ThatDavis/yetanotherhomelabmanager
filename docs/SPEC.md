# Specification — Yet Another Home Lab Manager

> Last updated: 2026-09-28

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
- [ ] Which PVE node hosts the app itself (update orchestration must handle self-host node) — Owner: operator, Due: before M3
- [ ] Tamper-evidence (hash-chained audit log) deferred — revisit if threat model changes — Due: TBD
