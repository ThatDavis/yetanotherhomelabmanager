# UI/UX Guidelines — Yet Another Home Lab Manager

> Last updated: 2026-09-28
> Agreed during pre-M1 design session. Applies to all milestones; amend via discussion, not drift.

## Principles

Single-operator **dark, dense console**. Information density over decoration; every screen answers "what needs my attention?" within seconds. Desktop-first, usable on mobile (check status, approve jobs).

## 1. App Shell

- **Left sidebar** (collapsible to icons) + content area.
- Sidebar header shows a **node-health summary chip** (worst current status across nodes) — always visible, links to Dashboard.
- Sidebar sections **grow with milestones**:
  - M1: Dashboard, Nodes, Guests, Jobs, Audit, Settings
  - M3 adds: Updates · M4 adds: Backups · M5 adds: Migrations
- No "coming soon" placeholder sections.

## 2. Landing / Dashboard

- Login lands on **Dashboard**: status at a glance — node health cards, recent jobs, failing checks, stale backups (M4+).
- M1 dashboard is modest (node list status + recent audit/job activity) but the layout is the M2 layout — don't build a throwaway.

## 3. Status Semantics (fixed, global)

| State | Catppuccin hue | Meaning |
|-------|----------------|---------|
| ok | green | healthy / succeeded |
| warn | peach | degraded / attention needed |
| error | red | failed / down |
| unknown | overlay1 | offline / unreachable / no data |
| running | sapphire | job in progress |

Rules:
- **Never color alone** — always paired with an icon or label (accessibility + gray/dark-theme safety).
- Identical mapping everywhere: tables, badges, dashboard cards, charts, toasts.
- Tailwind: use semantic token aliases (e.g. `text-status-ok`) defined once in the theme, not raw color classes scattered through components.

## 4. Core Patterns

- **Create/edit forms** open in a **right slide-over drawer** — the list/context stays visible behind.
- **Lists are tables** with sort + filter; row click navigates to the **detail page**.
- **Destructive actions:**
  - Standard destructive (remove registration): confirm modal.
  - High-risk (reboot, update, migration, delete data): confirm modal with **typed name confirmation** (type the node/guest name to enable the button).
- **Empty states** say what to do next ("Add your first PVE node"), never a bare blank table.
- Monospace for IDs, IPs, VMIDs, hostnames, logs.

## 5. Jobs & Long-Running Operations

- **Job center** (sidebar "Jobs"): persistent list of all jobs with state, progress, and timestamps.
- Live progress via **SSE** (poll fallback acceptable in M1).
- **Toast** on job completion/failure, regardless of current page; toast links to the job.
- Every job detail links to its **audit entries** and captured logs/output.
- Jobs that mutate infrastructure show a **pre-flight summary** before starting (what will happen, on which targets) — pattern from dockermigrate's plan review.

## 6. Theme, Color & Motion

- **Palette: Catppuccin Mocha** (darkest flavor), imported as the Tailwind theme source. Base surfaces: `base`/`mantle`/`crust`; text: `text`/`subtext0`/`subtext1`; borders: `surface0`–`surface2`.
- **Primary accent: mauve** — links, primary buttons, active nav, focus/glow tint. One accent only; status hues (§3) are reserved for status, never decoration.
- Compact spacing, dense tables. Light theme: optional later, not a goal; semantic tokens make it cheap if added.

### Retro-terminal accents (containment rules)

Inspiration: 80s industrial sci-fi terminals (Alien's MU/TH/UR, Nostromo consoles) — angular and utilitarian, **not** neon-noir cyberpunk. The vibe comes from shape, typography, and texture; hues stay Catppuccin.

- Allowed **only on decorative surfaces**: login screen, dashboard header, empty states, wordmark.
- Repertoire:
  - **Angular geometry** — cut-corner (chamfered) panels and buttons via `clip-path`, square corners elsewhere; no rounded-pill playfulness
  - **Typography** — monospace for headings/labels on themed surfaces, uppercase micro-labels with wide tracking (e.g. `SYS.STATUS // NODES`)
  - **Phosphor glow** — subtle single-color text-shadow (mauve or sapphire), restrained; no multi-color neon wash
  - **Texture** — faint scanlines or CRT-style horizontal banding behind the login card / dashboard header
  - **Framing** — thin `surface2` rule lines, corner ticks, panel labels like `▚ NODE ROSTER`
- **Never** on: data tables, drawer forms, status badges, audit log, job output/logs. Those stay flat and readable.

### Animations (simple, CSS-only)

- Duration 150–250ms, `ease-out` for entrances, `ease-in` for exits. No animation libraries.
- Standard set: drawer slide-in, toast enter/exit, skeleton shimmer while loading, slow pulse (2s) on `running` status, hover/focus transitions on interactive elements.
- Themed surfaces may add one terminal-flavored touch (e.g. boot-sequence text reveal or blinking block cursor on the login screen) — one per surface, never in data views.
- All motion disabled under `prefers-reduced-motion`.

## 7. Responsive Floor

- Desktop-first. On narrow screens: sidebar collapses to icons → overlay drawer; tables may scroll horizontally or collapse to cards — pick per-table, cards preferred for Dashboard/Nodes.
- Must remain possible from a phone: view dashboard, see job status, view audit log. Complex forms may be desktop-only.

## 8. Consistency Checklist (apply to every new screen)

- [ ] Uses status tokens, never raw colors
- [ ] Loading, empty, and error states all designed
- [ ] Destructive/high-risk actions follow §4
- [ ] Any operation >2s runs as a job per §5, not a spinner-blocking form
- [ ] Monospace for machine identifiers
- [ ] Works at 1280px wide without horizontal scroll of the page (tables excepted)
- [ ] Retro-terminal accents only on decorative surfaces (§6)
- [ ] Motion is CSS-only, 150–250ms, disabled under `prefers-reduced-motion`
