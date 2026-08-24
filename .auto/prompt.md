# Autoresearch: GUI bundle size

## Objective
Reduce the OpenCodex GUI initial bundle (main `index-*.js`) without breaking runtime or adding deps. Workload is `bun run build` in `gui/` (Vite/Rolldown). Current main is 280k (down from 755k orig via 7 chunks: claude 184k, providers 206k, modellen 41k, dashboard 13k, usage 18k, verkeer 16k). Target is <250k main while keeping all pages lazy and functional. This is a pure build-config + lazy-split optimization; no API/security change.

## Metrics
- **Primary**: `main_kb` (kB, lower is better) — size of `gui/dist/assets/index-*.js` after build. Extract via `ls -lh` or `stat`.
- **Secondary**: `gzip_kb` (kB) — gzip size, `total_js_kb` — sum of all chunks, `build_ms` — build time, `chunks` — count.

## How to Run
`./.auto/measure.sh` — outputs `METRIC main_kb=XXX` etc. Single run is fine (build is deterministic, not noisy).

## Files in Scope
- `gui/vite.config.ts` — manualChunks, build.rollupOptions
- `gui/src/pages/*.tsx` — page entry points (only to add `lazy()` wrappers if needed, no logic change)
- `gui/src/components/*` — only if a component is provably heavy and can be split (measure before/after)
- `gui/src/app-routing.ts` — if lazy routes need wiring (keep routing intact)

## Off Limits
- `src/` (proxy runtime) — not in scope for this bundle-only run
- `gui/src/i18n/*`, `gui/src/styles/*` — no style/i18n churn
- Any file that changes API, auth, or security behavior
- `package.json` / lockfile — no new deps
- `.git`, `devlog/`, `structure/`

## Constraints
- `bun x tsc --noEmit` must stay 0
- `bun run lint:gui` must stay 0
- `bun run build` must succeed and all chunks loadable (no missing imports)
- No watcher/poll loops; one-shot `bun run build` only
- Keep `manualChunks` function pure; no side effects
- Commit every experiment before measuring; revert on regress

## What's Been Tried
- 2026-08-24: 755k -> 587k via usage/verkeer/dashboard split (1 line, -22%)
- 2026-08-24: 587k -> 341k via + providers/modellen split (-42% vs 587k)
- 2026-08-24: 341k -> 280k via + claude/grok-apikeys split (-18% vs 341k)
- Baseline for this session is 280k main (feat/v1.2.2-bundle d4a1011). Next candidates: Storage, Logs, Instellingen, Combos, Models pages; shared components like ProviderWorkspaceShell; dynamic import() for heavy modals.
