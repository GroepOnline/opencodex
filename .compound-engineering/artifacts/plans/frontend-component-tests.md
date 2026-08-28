---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
title: "Frontend Component Tests — 5 Largest Untested GUI Components"
date: 2026-08-28
---

# Frontend Component Tests — 5 Largest Untested GUI Components

## Problem Frame

The OpenCodex GUI (`gui/src/pages/`) has 27 page components. The 5 largest by lines of code have **zero** focused component/render tests:

| Component | LOC | File |
|-----------|-----|------|
| Storage | 1478 | `gui/src/pages/Storage.tsx` |
| Models | 1405 | `gui/src/pages/Models.tsx` |
| Logs | 923 | `gui/src/pages/Logs.tsx` |
| Usage | 747 | `gui/src/pages/Usage.tsx` |
| ProviderWorkspaceShell | 599 | `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx` |

These components handle critical user-facing functionality (provider management, model catalog, log viewing, usage analytics, storage/backup). Without tests, regressions in rendering, loading states, error handling, and API integration go unnoticed until users report them.

## Scope

**In scope:**
- Focused render + state tests for the 5 components above
- Loading, error, and success states with mocked API responses
- Per-test global state isolation (save/restore pattern, no module-level hooks)

**Out of scope:**
- E2E browser tests (Playwright) — separate effort
- Visual regression testing
- Fixing the pre-existing `hideRedundantChatGptForwardProviders` null defect (7 failures) — tracked as residual
- Testing already-covered components (Dashboard, Providers, etc.)

## Requirements

### R1 — Storage component has render + state tests
- R1.1: Renders catalog backup section when backup exists
- R1.2: Shows loading state while fetching
- R1.3: Handles fetch error gracefully

### R2 — Usage component has render + state tests
- R2.1: Renders usage report panels with data
- R2.2: Shows error state on API failure
- R2.3: Handles empty data set

### R3 — Logs component has render + state tests
- R3.1: Renders log viewer with tabs
- R3.2: Shows empty state when no logs
- R3.3: Handles fetch error

### R4 — ProviderWorkspaceShell has render + state tests
- R4.1: Renders provider workspace for a given provider
- R4.2: Handles provider fetch failure
- R4.3: Renders with empty provider data

### R5 — Models component has render + state tests
- R5.1: Renders model groups
- R5.2: Shows empty provider hint when no providers
- R5.3: Handles discovery failure state

### R6 — Test infrastructure is isolated
- R6.1: Each test saves/restores `globalThis.fetch`, `document`, `window`, `navigator`, `localStorage`
- R6.2: No module-level `beforeEach`/`afterEach` that mutate globals
- R6.3: `try`/`finally` guarantees cleanup even on throw

## Existing Patterns to Follow

The established test pattern in this repo (`gui/tests/`):
- **Runtime**: `bun:test` with `happy-dom` for DOM environment
- **Render**: `react-dom/server` `renderToStaticMarkup` for static render tests; `react-dom/client` `createRoot` + `act` for interactive
- **i18n**: Wrap in `<LanguageProvider>` from `gui/src/i18n/provider`
- **Locales**: `await seedDicts()` from `gui/tests/helpers/locales`
- **Fetch mock**: Replace `globalThis.fetch` with a handler function returning `Response.json(...)`
- **DOM setup**: `new Window({ url: "http://localhost/" })` from `happy-dom`, assign to `globalThis`

Reference test files:
- `gui/tests/models-empty-provider.test.tsx` — pattern for model discovery + provider hints
- `gui/tests/frontend-component-coverage.test.tsx` — the file we created (needs isolation fix)

## Implementation Units

### IU1 — Fix test isolation in `frontend-component-coverage.test.tsx`
**File**: `gui/tests/frontend-component-coverage.test.tsx`

Replace module-level `beforeEach`/`afterEach` with per-test `setupEnv()` helper:
- Each test calls `setupEnv()` which captures current globals and returns a `cleanup()` function
- Tests use `try { ... } finally { cleanup() }` to guarantee restoration
- `mount()` helper takes per-test `TestEnv` instead of module-level variables

**Test scenarios:**
1. Storage renders catalog backup section (mock `/api/storage` → `{ catalog_backup_exists: true }`)
2. Storage shows loading state (fetch never resolves)
3. Usage renders panels (mock `/api/usage` → `{ rows: [], total_tokens: 0 }`)
4. Usage handles error (fetch → 500)
5. Logs renders with tabs (mock `/api/logs` → `{ lines: [] }`)
6. Logs shows empty state
7. ProviderWorkspaceShell renders (mock `/api/providers?name=X` → provider object)
8. ProviderWorkspaceShell handles fetch failure

### IU2 — Add Models render + state tests
**File**: `gui/tests/frontend-component-coverage.test.tsx` (append) or new `gui/tests/models-render.test.tsx`

**Test scenarios:**
1. Renders model groups when providers exist (reuse `gatherRoutedModels` + `withStubbedProviderFetch` from existing test helpers)
2. Shows `EmptyProviderHint` when no providers configured
3. Handles discovery failure (mark provider discovery failed via `markProviderDiscoveryFailed`)

### IU3 — Verify full suite green
**Command**: `cd gui && bun test`

**Acceptance**: 0 failures across all 91 GUI test files (439 tests).

## Key Decisions

1. **Per-test save/restore over module-level hooks** — Module-level `beforeEach`/`afterEach` that mutate `globalThis` leak across test files in Bun's shared-process model. Per-test `try`/`finally` is the defensive pattern.

2. **Single test file for the 5 components** — Keeps related coverage together; matches existing flat test layout. Split only if the file grows unwieldy (>50 tests).

3. **Mock at `globalThis.fetch` level** — These are render/state tests, not API contract tests. Mocking fetch is the established repo pattern.

4. **Don't fix `hideRedundantChatGptForwardProviders` null defect** — Pre-existing, separate concern. Track as residual review finding.

## Risks

- **happy-dom limitations**: Some browser APIs may be missing. Mitigation: use `renderToStaticMarkup` for pure render tests; reserve `createRoot`+`act` for interactive state tests.
- **Component prop shapes**: Large components may have complex prop requirements. Mitigation: inspect component signatures before writing mocks.
- **i18n keys**: Tests must use real translation keys or `seedDicts()` must cover them.

## Dependencies & Sequencing

1. IU1 (fix isolation) — must land first, unblocks reliable test runs
2. IU2 (Models tests) — independent, can run in parallel with IU1 verification
3. IU3 (verify suite) — runs after IU1 and IU2 land

## Test File Paths

- `gui/tests/frontend-component-coverage.test.tsx` — Storage, Usage, Logs, ProviderWorkspaceShell tests + isolation fix
- `gui/tests/models-render.test.tsx` (optional) — Models render tests if appended to coverage file becomes too large
