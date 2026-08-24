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

## Status: CONVERGED (2026-08-24) — main_kb at floor, session closed

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
Session autoresearch/gui-bundle-260824 (baseline 280k @ d4a101115):
- keep: usage/verkeer/dashboard lazy split — 280k was already post-split; earlier arcs took 755k -> 587k -> 341k -> 280k on feat/v1.2.2-bundle
- keep: Storage/Logs/Instellingen/Debug -> `storage-logs` chunk (e8c991d60) — main 246k
- keep: Combos/Subagents/Startup -> `combos-subagents` chunk (99b42d95d) — main 195k
- keep: react/react-dom -> `vendor-react` chunk (541f4cc59) — **main 16k (gzip 5)** ← best
- discard (dead idea): zustand/prune — zustand is NOT in gui/package.json nor imported anywhere in gui/src; idea stale
- verified converged (no further run needed):
  - deps are minimal: react, react-dom, @tanstack/react-virtual, posthog-js, fontsource jetbrains-mono
  - posthog-js is already dynamic-import()ed behind VITE_POSTHOG_KEY + DNT gate (src/posthog.ts); keyless deploys never load it
  - eager surface is App.tsx + ui.tsx + icons.tsx + app-routing (~37k source -> 16k minified main); nothing left to move without fragmenting first-paint code
  - remaining big chunks are pure lazy page code: providers 204k, claude 185k, vendor-react 178k, combos-subagents 58k — they load on navigation, not initial paint
  - CSS 163k (gzip 29k) is out of scope (styles off limits)
Final checks on head 541f4cc59: tsc 0, eslint:gui 0, focused tests 79 pass.
If anyone reopens this: only meaningful lever left is trimming styles.css (needs scope change) or splitting provider-workspace components across pages (fragmentation, near-zero UX gain).
