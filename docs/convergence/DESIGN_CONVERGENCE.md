# OCX 3.0 Design Convergence — Lane D

Captured: 2026-08-23 · Branch: `convergence/lane-d-product` · Base: `origin/main` @ 4a589932

Authority chain: [ADR 0005](../adr/0005-gui-design-token-system.md) → `gui/src/styles.css` → `docs/design-system/*` → `.github/design-system.json` → `design-system-contract.yml`.

---

## 1. Design drift inventory (quantified)

Audit scope: `gui/src/` (182 source files at audit start; 13 CSS modules after `depas.css` removal).

### 1.1 Styling dialects in play

| Dialect | Location | Status |
|---|---|---|
| **OCX token layer (authority)** | `gui/src/styles.css` `:root` — 117 custom properties, `light-dark()` semantic colors, 8-step type scale, 4px spacing, motion tokens | **Authority** |
| **Workspace modules** | 12 imported `styles/*.css` + `styles-*-workspace.css` files — extend tokens for provider/catalog/combos/storage | Allowed extensions |
| **De Pas (`depas-*`)** | Was `styles/depas.css` (568 lines, 14 hex) + `depas-viewkop`/`depas-viewsub` in Modellen/Verkeer | **Removed this lane** |
| **Legacy Signaal names** | `bon`/`stempel` in traffic (partially renamed in open PR #88) | Superseded by `traffic-*` |
| **General Sans vendored fonts** | `@font-face` in `styles.css`, woff2 in `assets/fonts/` | In authority (self-hosted, offline-safe) |
| **`strak` skin** | `:root[data-style="strak"]` token overrides | Second skin, same token names |
| **Inline JSX styles** | 57 files, **305** `style={{}}` blocks | Drift vector — layout OK, visual roles not |
| **Orphan pages** | `Modellen.tsx`, `Instellingen.tsx`, `Logs.tsx`, `Debug.tsx`, `ClaudeCode.tsx`, `ClaudeDesktop.tsx` — not mounted directly from `App.tsx` routing | IA debt |

### 1.2 Hard-coded values (pre-convergence baseline)

| Metric | Count | Notes |
|---|---:|---|
| CSS files | 13 | Down from 14 after `depas.css` delete |
| CSS `var(--*)` usages | ~1,605 | Good token adoption in CSS |
| **Distinct hex colors (all sources)** | **68** (was 89 incl. depas) | 59 in `styles.css` (token definitions); remainder in workspace CSS + 8 TS data/helpers |
| Hard-coded color literals in CSS | ~179 | Expected at token definition layer |
| **Non-token `font-size` in CSS** | **26** | Mostly legacy rem values in workspace modules |
| **Distinct easing curves** | **2** canonical + 3 aliases | `cubic-bezier(0.22,1,0.36,1)`, `cubic-bezier(0.4,0,1,1)`; raw `ease`/`ease-in`/`ease-out` still appear in a few rules |
| Non-token `font-family` | 2 | `@font-face` "General Sans" declarations only |
| Non-token `border-radius` | 11 | Mostly workspace one-offs |
| Hardcoded px spacing values | ~106 distinct | Gap/margin/padding not yet on `--space-*` |
| Inline `style={{}}` blocks | **305** in **57** files | Top: `Models.tsx` (25), `claude-code-sections.tsx` (22), `Usage.tsx` (18) |
| `depas-*` class references | **0** (was 2 files) | Migrated to `page-head` / `page-sub` |

### 1.3 Historical naming layers

| Layer | Examples | Disposition |
|---|---|---|
| Dutch route IDs | `leveranciers`, `modellen`, `verkeer`, `verbruik`, `systeem` | Keep as hash keys; display labels via i18n |
| De Pas | `depas-viewkop`, `depas-app`, `var(--wijn)`, `var(--gietijzer)` | **Deleted / ESLint-blocked** |
| Signaal traffic | `bon`, `stempel`, `stat-strip-waarde` | Partially renamed; `traffic-*` is target (#88) |
| English orphan pages | `Dashboard`, `Startup`, `Providers` | Canonical components; routing names lag |

---

## 2. Token authority spec

Single runtime source: **`gui/src/styles.css` `:root`**. No parallel token file, no Tailwind, no CSS-in-JS. Machine contract: `.github/design-system.json` (pinned to `GroepOnline/design-system`).

### 2.1 Token categories (extended this lane)

| Category | Tokens | Consumer primitives |
|---|---|---|
| **Typography** | `--font-ui`, `--font-code`, `--text-micro`…`--text-display`, `--weight-*`, `--leading-*`, `--tracking-*` | `.text-*` utilities, `.page-head h2`, `.tbl`, `.btn` |
| **Spacing** | `--space-0-5`…`--space-16` | `.panel`, `.card`, form rows, grid gaps |
| **Radius** | `--radius-2xs`…`--radius-pill` | `.card`, `.input`, `.badge`, modals |
| **Borders / surfaces** | `--bg`, `--rail`, `--surface`, `--raised`, `--border`, `--border-soft`, `--hover` | App shell, cards, tables |
| **Semantic colors** | `--text`, `--muted`, `--faint`, `--accent*`, `--green`, `--amber`, `--red` + `-soft` variants | Buttons, notices, links |
| **Operational status** *(new)* | `--status-{healthy,degraded,rate-limited,cooldown,expired,auth-failed,disabled,unknown}-{fg,bg}` | `StatusBadge`, OAuth health, account rows, health table |
| **Motion** | `--motion-fast/normal/slow`, `--ease-out`, `--ease-in` | Transitions; `prefers-reduced-motion: reduce` zeroes all |
| **Focus** *(new)* | `--focus-ring`, `--focus-ring-width`, `--focus-ring-offset` | `:focus-visible` on controls (migrate scattered `--accent-ring` uses over time) |
| **Controls** | `--control-sm/md/lg/touch`, `--icon-sm/md/lg`, toggle tokens | `.btn`, `.switch`, `.select-trigger` |
| **Elevation** | `--shadow`, `--shadow-sm` | Modals/overlays only — no product-card shadows |

### 2.2 TypeScript bridge

- `gui/src/design-tokens.ts` — `OperationalStatus` union + `statusBadgeClass()`
- `gui/src/ui.tsx` — `Badge`, `StatusBadge`, `Switch`, `Select`, `EmptyState`, `Notice`, `Tooltip`
- `gui/src/oauth-health-display.ts` — maps API health → `OperationalStatus` (migrated)

Legacy `badge-green` / `badge-amber` / `badge-muted` remain for non-operational labels (Free, Local, default model). New operational surfaces MUST use `StatusBadge` or `badge-status-*`.

### 2.3 Primitive consumption map

| Primitive | Token-only contract |
|---|---|
| **Tables** | `.tbl` + `--text-control` / `--text-label`; status cells use `StatusBadge` |
| **Forms** | `.input`, `.field-label`, focus via `--accent-soft` ring |
| **Buttons** | `.btn` variants; `--control-*` heights; no inline hex |
| **Badges** | Operational → `badge-status-*`; categorical → `badge-green/amber/muted` |
| **Empty states** | `.empty` + `--text-title`, `--text-control` |
| **Skeletons** | `--raised` + `--motion-normal` shimmer (existing patterns) |
| **Dialogs** | `.modal-*` + `--shadow`, `--radius-lg` |
| **Toasts** | `.notice-ok/err/warn` |
| **Navigation** | `.view-tab`, `.sub-tab`, `.nav-item` — `--rail`, `--text-control` |
| **Icons** | `--icon-sm/md/lg`; active `--text`, inactive `--faint` |

---

## 3. Information architecture — seven views

### 3.1 Current routes (`app-routing.ts` + `App.tsx`)

| Current hash | Component | Sub-routes |
|---|---|---|
| `#dashboard` | `Dashboard.tsx` | — |
| `#leveranciers` | `Providers.tsx` | workspace inline |
| `#leveranciers/claude` | `Claude.tsx` | — |
| `#leveranciers/grok` | `Grok.tsx` | — |
| `#modellen` | `Models.tsx` | — |
| `#modellen/combos` | `Combos.tsx` | — |
| `#modellen/subagents` | `Subagents.tsx` | — |
| `#verkeer` | `Verkeer.tsx` → logs + inline usage stats | — |
| `#verkeer/debug` | `Verkeer.tsx` → `Debug.tsx` | — |
| `#verbruik` | `Usage.tsx` | — |
| `#systeem` | `Startup.tsx` + `DangerZone` | — |
| `#systeem/storage` | `Storage.tsx` | — |
| `#systeem/api` | `ApiKeys.tsx` | — |
| *(sheet)* | `SettingsSheet.tsx` | theme |
| *(orphan)* | `Modellen.tsx`, `Instellingen.tsx`, `Logs.tsx`, `ClaudeCode.tsx`, `ClaudeDesktop.tsx` | unwired or embedded |

Legacy redirects: `providers`, `models`, `usage`, `logs`, `startup`, `storage`, `api`, etc. → canonical hashes.

### 3.2 Target mapping

| Current | Target view | Action | Justification |
|---|---|---|---|
| `dashboard` | **Overview** | RENAME + REDESIGN | Collapse card soup → status line + 3 blocks + activity |
| `leveranciers` (+ workspace) | **Providers** | KEEP + deepen | Primary management surface; Claude/Grok become provider workspace tabs |
| `leveranciers/claude`, `/grok` | **Providers** › provider tab | MERGE | Provider-specific pages fold into workspace, not top-level nav |
| `modellen`, `/combos`, `/subagents` | **Models** | KEEP (sub-tabs) | Routing catalog; combos/subagents stay as Models sub-tabs |
| `verkeer`, legacy `logs` | **Traffic** | KEEP + REDESIGN | Operational request table + detail drawer; drop decorative stat strip duplication |
| `verkeer/debug` | **Traffic** › Debug panel | MERGE | Debug is a Traffic mode, not a sibling product area |
| `verbruik`, legacy `usage` redirect | **Usage** | KEEP | Billing/coverage analytics — distinct from live Traffic |
| `systeem` (Startup health) | **Health** | SPLIT | One truth table: Proxy / Mgmt API / Persistence / providers / deploy runner |
| `systeem/storage`, `/api` | **Settings** | MERGE | Storage policy + API keys + theme + danger zone |
| `SettingsSheet` | **Settings** | MERGE | Theme/locale become Settings sections |
| `Modellen.tsx` (wrapper) | — | **REMOVE** | Duplicate of App sub-tabs + `Models.tsx` |
| `Instellingen.tsx` | **Settings** | MERGE or REMOVE | If unused, delete |
| `ClaudeCode.tsx`, `ClaudeDesktop.tsx` | **Providers** › Claude tab | MERGE | Provider configuration, not global nav |
| `Logs.tsx` | **Traffic** | MERGE | Becomes Traffic table implementation detail |

### 3.3 Target nav (7 items)

```
Overview | Providers | Models | Traffic | Usage | Health | Settings
```

Hash proposal (migration phase keeps legacy redirects):

```
#overview | #providers | #models | #traffic | #usage | #health | #settings
```

---

## 4. Seven-view designs (wireframes)

Visual direction: developer infrastructure console — matte surfaces, hairline borders, one blue accent, monospace for machine data. No gradients, glow, purple blobs, or decorative motion.

### 4.1 Overview

```
┌─ Status line ─────────────────────────────────────────────────────────────┐
│ ● Operational · 12 accounts ready · 18 providers · 2 degraded · 24h: 4.2k req · 98.1% OK │
└───────────────────────────────────────────────────────────────────────────┘
┌─ Capacity ──────────────┐ ┌─ Traffic ───────────────┐ ┌─ Issues ──────────┐
│ Ready / cooldown / cap  │ │ Last 10 requests (table)│ │ Degraded accts    │
│ per top-3 providers     │ │                         │ │ Rate limits       │
└─────────────────────────┘ └─────────────────────────┘ └───────────────────┘
┌─ Recent activity ─────────────────────────────────────────────────────────┐
│ time · provider · model · status · latency                                │
└───────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Providers

```
┌─ Provider cards (grid) ───────────────────────────────────────────────────┐
│ [icon] OpenAI    ● healthy   3 ready · ~120 req/h · gpt-4.1 · 2m ago      │
│ [icon] Anthropic ◐ degraded  1 cooldown · ~40 req/h · claude-sonnet · 5m  │
└───────────────────────────────────────────────────────────────────────────┘
  └─ drill-down workspace:
     ┌ Rail ──────────┬─ Detail tabs ──────────────────────────────────────┐
     │ ● OpenAI       │ Overview | Accounts | Models | Usage | Events | Config │
     │ ○ Anthropic    │ ┌─ Accounts ────────────────────────────────────────┐ │
     │ ○ Google       │ │ state · auth kind · expiry · today · last OK · RL │ │
     └────────────────┴─└──────────────────────────────────────────────────┘ │
```

Accounts tab: factual runtime status only — **never secrets** (masked email / ordinal labels).

### 4.3 Models

Sub-tabs: **Catalog | Combos | Subagents**. Table/grid of models with provider grouping, enable/disable, context caps. No dashboard cards.

### 4.4 Traffic

```
┌─ filters: provider · status · time range ─────────────────────────────────┐
│ time      provider  account   model      status  latency  tokens  retry id│
│ 14:02:01  openai    acct…3    gpt-4.1    200     842ms    1.2k    req_…   │
│ 14:01:58  anthropic acct…1    claude-…   429     120ms    —       req_…   │
└───────────────────────────────────────────────────────────────────────────┘
  └─ detail drawer (no secret bodies by default):
     routing decision · selected account · attempts · provider metadata · latency breakdown · failure class
```

### 4.5 Usage

30d token/cost/coverage analytics. Segmented filters (source × period). Distinct from live Traffic.

### 4.6 Health

```
┌─ Component ──────────── Status ─── Cause / last check ────────────────────┐
│ Proxy                  ● OK       v1.2.1 · uptime 4d                      │
│ Management API         ● OK       auth OK · 12ms                          │
│ Persistence            ● OK       config.json · usage.jsonl               │
│ Provider: openai       ◐ Degraded  1 account cooldown (rate_limit)        │
│ Provider: anthropic    ● OK       2 accounts ready                        │
│ Deploy runner          ○ Unknown   no runs recorded                       │
└───────────────────────────────────────────────────────────────────────────┘
```

Causality required — not bare green/red dots.

### 4.7 Settings

Sections: **General** (theme, locale) · **API access** · **Storage** · **Danger zone** (stop proxy). Sheet pattern merges into full page.

---

## 5. Relationship to PR #88

| PR #88 change | Lane D stance |
|---|---|
| Delete `depas.css`, rename `depas-viewkop` → `page-head` | **Done independently** — same outcome; absorb, do not wait |
| `traffic-rail.css`, `bon` → `traffic-*` | **Absorb** — aligns with Traffic view redesign |
| General Sans + FONTSHARE-LICENSE | **Already on main** — keep |
| Toggle easing `ease` → `var(--ease-out)` | **Extend** — badge-clickable migrated; grep remaining raw `ease` |
| Tokenized stat-strip | **Keep** — Overview block input |

**#88 is a cosmetic patch, not the authority model.** It removes one dialect but does not prevent recurrence. Lane D adds:

- Operational status token layer + `StatusBadge` primitive
- ESLint + CI drift gate
- IA spec toward 7 views
- This document as convergence record

**Recommendation:** Merge #88 into dev first (low conflict), then land convergence branch for tokens + enforcement + IA routing rename (separate PR).

---

## 6. Enforcement plan

### 6.1 Implemented

| Layer | Mechanism | Catches | Cannot catch |
|---|---|---|---|
| **ESLint** `local-design-token/no-depas-dialect` | error on `depas-*`, `--wijn`, `gietijzer` | Legacy class/token strings in TS/CSS | Hex in `.css` token definitions (allowed) |
| **ESLint** `local-design-token/no-inline-visual-values` | warn on `#hex`, raw `Npx` fontSize, raw easing in `style={{}}` | New inline visual drift in JSX | Algorithmic inline layout (`width: count * 8`) |
| **CI script** `gui/scripts/check-design-drift.mjs` | fails on depas import/class/legacy token | Structural regression | Gradual hex accumulation in CSS modules |
| **Workflow** `design-system-contract.yml` | runs validator + `bun run lint:design-tokens` | Contract pin + lint gate on `gui/**` changes | Backend `src/`, undeclared CSS outside `gui/` |
| **Pinned contract** `.github/design-system.json` | `validate-consumer-contract.py` | Repo ↔ design-system repo SHA | Visual regressions |

### 6.2 Future (not implemented — needs baseline burn-down)

- Promote `no-inline-visual-values` from **warn → error** after top-10 inline-style files migrated
- Stylelint on `gui/src/**/*.css` forbidding hex outside `:root` / `[data-style]` blocks
- `--max-inline-styles 305` ratchet in `check-design-drift.mjs` (fail if count increases)

---

## 7. Implementation summary (this branch)

| Done | Pending (design-only or later lanes) |
|---|---|
| Removed `depas.css`; migrated Modellen/Verkeer headers | Full IA route rename (`overview`, `providers`, …) |
| Added 8 operational status token pairs + focus tokens | Overview layout redesign |
| Added `design-tokens.ts`, `StatusBadge`, `Badge` | Migrate 305 inline styles |
| Migrated `oauth-health-display.ts` → operational badges | Health truth table UI |
| Migrated `startup-sections.tsx` hero badges | Provider workspace tab consolidation |
| ESLint design-token plugin + CI drift script | Stylelint CSS hex gate |
| Extended `design-system-contract.yml` | Merge PR #88 traffic-rail.css |

---

## 8. Build verification

Local workstation: Node **v24.5.0**, Bun **1.3.14** (snapshot noted production host Node 18.19.1 is too old for Vite ≥20.19).

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | OK (177 packages) |
| `bun run lint` | OK — 0 errors, 3 warnings (inline hex fallbacks in Models/OAuthAccountPoolSettings) |
| `bun run lint:design-tokens` | OK — drift gate PASS (182 files, 0 depas hits, 5 distinct hex in TSX) |
| `bun run build` | OK — 161 modules, CSS 157.47 kB, JS 766.10 kB, General Sans woff2 bundled |
| `bun run doctor` | OK — no issues (changed scope vs origin/main) |
| `bun test tests/oauth-health-display.test.ts` | OK — 9/9 pass |
