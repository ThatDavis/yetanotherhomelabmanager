# Yet Another Home Lab Manager

A web UI to manage and monitor homelab servers, and orchestrate/automate backups, updates, and migration of containers across VMs — Proxmox-first, with security and auditing at its core.

## Stack

- **Language:** TypeScript (Node.js 22+)
- **Backend:** Fastify
- **Frontend:** React SPA (Vite) + Tailwind CSS
- **Database:** PostgreSQL + Prisma
- **Auth:** Passkeys (WebAuthn)
- **Testing:** Vitest
- **Lint/Format:** Biome
- **Package manager:** pnpm (workspace: `server/` + `web/`)
- **CI/CD:** GitHub Actions
- **Hosting:** Docker Compose on the homelab, behind an existing reverse proxy/CA

## Getting Started

### Prerequisites

- Node.js >= 22
- pnpm >= 12
- Docker + Docker Compose (deployment only)
- A reverse proxy providing HTTPS + a stable hostname (required for passkeys)

### Setup

```bash
git clone https://github.com/ThatDavis/yetanotherhomelabmanager.git
cd yetanotherhomelabmanager
pnpm install

cp .env.example .env
# Edit .env: set MASTER_KEY (openssl rand -hex 32), SESSION_SECRET, RP_ID, ORIGIN

# Dev: start Postgres, API (:3000) and web dev server (:5173, proxies /api)
docker compose up -d db
pnpm dev
```

### Running Tests

```bash
pnpm test      # vitest in server/ and web/
pnpm check     # biome lint + format check
pnpm build     # production builds
```

### Deployment

```bash
docker compose up -d --build
```

Point your reverse proxy (TLS) at `127.0.0.1:3000`. `RP_ID`/`ORIGIN` in `.env` must match the public hostname exactly, or passkey auth will fail.

## Project Structure

```
.
├── server/            # Fastify API (@yahlm/server)
│   ├── src/           #   app.ts (factory; serves web/dist SPA + /health), index.ts (entry)
│   ├── prisma/        #   schema + migrations
│   └── test/          #   vitest (health, SPA fallback)
├── web/               # React SPA (@yahlm/web)
│   ├── src/
│   │   ├── components/  # AppShell, Sidebar, Panel, StatusBadge, …
│   │   ├── pages/       # Dashboard, Nodes, Guests, Jobs, Audit, Settings
│   │   └── index.css    # Catppuccin Mocha theme + status tokens (docs/UI.md)
│   └── test/          #   vitest (router/pages)
├── docs/              # SPEC.md, ARCHITECTURE.md, UI.md, adr/
├── .agent/            # CONTINUITY.md — canonical briefing for AI sessions
├── Dockerfile         # Multi-stage: build web + server, run with migrations
├── docker-compose.yml # app + postgres
└── PLAN.md            # Roadmap
```

In production the Fastify server serves the built SPA from `web/dist` (client-route
fallback to `index.html`; `/api/*` misses stay JSON 404). Override the location with
the `SPA_DIR` env var.

## Features

App shell complete: themed sidebar, dashboard, section routing, production SPA serving. See [PLAN.md](PLAN.md) for the roadmap:

1. **M1 — Foundation:** passkey auth, audit log, encrypted secrets, PVE/PBS + host inventory, Proxmox API client, SSH executor
2. **M2 — Monitoring:** dashboards, health checks, alerting
3. **M3 — Updates:** scheduling, reboot orchestration, post-update verification, email reports
4. **M4 — Backups:** PBS status/stale alerts, automated restore testing
5. **M5 — Migration:** cross-node container migration (informed by [dockermigrate](https://codeberg.org/ThatNaysayer/dockermigrate))
