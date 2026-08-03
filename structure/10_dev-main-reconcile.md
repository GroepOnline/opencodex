# 10 — `dev` ↔ `main` reconcile notes

Status: in progress (CHE-5 / Phase 0). Companion to
[`09_x10-terminal-plan.md`](09_x10-terminal-plan.md).

## Divergence

As of 2026-08-03 the fork branches are **diverged**:

| Direction | Approx. commits |
| --- | --- |
| `dev` ahead of `main` | ~222 |
| `main` ahead of `dev` | ~43 |

`dev` is the integration branch. Prefer porting missing `main` value into `dev`
over resetting `main` until the open PR train (#51/#53/#52) lands.

## Already present on both (no port needed)

- OmniRoute, Tencent Coding Plan, SiliconFlow presets
- Claude Desktop integration
- ChefGroep GUI redesign / Dutch default (stronger on `dev`)
- Server PostHog, budgets, percentiles, pricing modules
- Admission rate-limit + Prometheus metrics + plugin contract (`dev` only — keep)
- ChefVault provider-security (`dev` only — keep)

## Ported in this reconcile PR

| Item | Decision |
| --- | --- |
| `src/codex/pacer.ts` + tests | **Ported and re-wired** into `responses/core.ts` + `compact.ts`. On `main` the original `responses.ts` call site was lost after the responses split; types existed on `dev` without implementation. |
| Auto-enable | Honors both `accountPoolStrategy: "round-robin"` (canonical on `dev`) and the fork alias `codexRotationMode: "round-robin"`. |

## Explicitly NOT ported (with reason)

| Item | Reason |
| --- | --- |
| De Pas pages (`Modellen`/`Verkeer`/`Systeem`/`Instellingen` + `depas.css`) | Unwired stubs on `main` only. Rebuild under ChefGroep skins in Phase 3 ([CHE-10](https://linear.app/chefgroepp/issue/CHE-10)); do not revive dead routes. |
| Extra GUI locales (`de`/`ja`/`ko`/`ru`/`zh`) | `dev` intentionally en/nl-only (#34). |
| `gui/src/posthog.ts` client | Privacy/scope review; server PostHog already on `dev`. Phase 4. |
| Duplicate tests (`percentiles.test.ts` etc.) | Already covered on `dev` as `usage-percentiles.test.ts`, `telemetry-posthog-server.test.ts`, … |
| `v1.0.0-alpha.1` bump on `main` | Release after reconcile + PR train; do not bump from a side PR. |
| `devlog/` chase trees on `main` | Historical; not product runtime. |

## Remaining Phase 0 human steps

1. Merge [#51](https://github.com/OnlineChefGroep/opencodex/pull/51) → [#53](https://github.com/OnlineChefGroep/opencodex/pull/53) → undraft+merge [#52](https://github.com/OnlineChefGroep/opencodex/pull/52).
2. Land this reconcile PR into `dev`.
3. Promote a coherent `main` from `dev` when ready for alpha (CHE-6).
