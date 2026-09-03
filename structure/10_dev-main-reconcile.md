# 10 — `dev` ↔ `main` reconcile notes

Status: current (2026-08-10). Historical Phase 0 notes below are retained for
context; do not treat the 2026-08-03 divergence table as live.

## Current state

As of 2026-08-10:

| Fact | Value |
| --- | --- |
| `dev` tip | tracks `main` (fast-forward) |
| Integration target for PRs | `main` |
| Release branch | `main` |
| Dependabot | enabled, `target-branch: main` |

Prefer landing work on `main`. Same-repository `dev` → `main` promotion remains
an explicit leftover exception in the target-branch check.

## Historical divergence (2026-08-03)

At that date the fork branches were **diverged** (~222 ahead / ~43 behind). The
reconcile PR train and later promotions closed that gap. The table is kept so
old PR comments remain intelligible:

| Direction | Approx. commits (2026-08-03) |
| --- | --- |
| `dev` ahead of `main` | ~222 |
| `main` ahead of `dev` | ~43 |

## Already present on both (no port needed)

- OmniRoute, Tencent Coding Plan, SiliconFlow presets
- Claude Desktop integration
- ChefGroep GUI redesign / Dutch default
- Server PostHog, budgets, percentiles, pricing modules
- Admission rate-limit + Prometheus metrics + plugin contract
- ChefVault provider-security

## Ported in the original reconcile PR

| Item | Decision |
| --- | --- |
| `src/codex/pacer.ts` + tests | Ported and re-wired into `responses/core.ts` + `compact.ts`. |

## Explicitly NOT ported (with reason)

| Item | Reason |
| --- | --- |
| De Pas pages | Unwired stubs; rebuild under Signaal/design-system if needed |
| Extra GUI locales beyond en/nl | Intentional |
| Duplicate tests | Already covered under newer names |

## Operator checklist

1. Open feature PRs against `main`.
2. Same-repository `dev` → `main` promotion remains an explicit leftover exception.
3. Keep Dependabot targeting `main` (see `.github/dependabot.yml`).
