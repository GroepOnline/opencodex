# Branch disposition graph

Wave 0 baseline: `origin/main` @ `4a589932` (2026-08-18). Compared
2026-08-23 from worktree `convergence/lane-a-git`. Unique commits are
`git log origin/main..<ref>`. Equivalence uses cherry-mark plus tip-to-tip
file inspection against `origin/main` and, where the work landed only on
`origin/dev`, against the matching squash on `origin/dev`.

Classes: **KEEP** (land or retain as trunk), **PARTIAL** (some unique
content remains; listed commits only), **DUPLICATE** (no unique commits),
**SUPERSEDED** (unique SHAs exist but the tree is already on main or
dev), **EXPERIMENT** (explicit WIP / parallel trial), **DEAD**,
**UNKNOWN**.

Open PRs #88 and #90 are listed after the 20 `refs/remotes/origin` rows.
They share heads with two of those branches.

| Ref | Tip | Ahead / behind main | Unique vs main | Subsystems | Tests | Equiv. on main/dev | Prod | Migrate | FE | Class | Why |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `origin/HEAD` | `4a589932` | 0 / 0 | 0 | — | no | is `origin/main` | — | — | — | DUPLICATE | Symbolic ref; no unique commits. |
| `origin/main` | `4a589932` | 0 / 0 | 0 | trunk | — | self | yes | — | — | KEEP | GitHub default branch and release line. |
| `origin/dev` | `07bc1f60` | 5 / 0 | 5 | availability, cache, routing, deploy, GUI, docs | yes | none on main | yes | low (additive module) | yes | KEEP | Only integration tip still 5 ahead of main; must land before retirement. See `DEV_RETIREMENT.md`. |
| `origin/ci/auto-deploy-and-hygiene` | `834f747f` | 10 / 18 | 10 | `.github/workflows`, actionlint, yamllint | yes | tip-to-tip CI files match main (`7ae5be98` + later) | yes (already live on main) | — | no | SUPERSEDED | Extra hardening (dirty checkout, tag pin) is already on main; branch is 18 behind. |
| `origin/docs/signaal-v3-consumer-naming` | `c981dd9f` | 5 / 0 | 5 | `gui/DESIGN.md`, `gui/src/styles.css` | no | tree identical to `07bc1f60` (#89 on dev) | no | none | comments only | SUPERSEDED | Same tree as #89; leftover branch SHA. |
| `origin/feat/provider-fetch-models` | `5296ac92` | 8 / 16 | 8 | GUI models, `provider-routes`, catalog | yes | #65 (`68eb6a19`) landed the feature; `refresh-models.ts` matches main | no | none | yes | PARTIAL | Retain review hardening that still differs in `provider-routes.ts`. |
| `origin/fix/availability-standard` | `de51ab13` | 9 / 0 | 9 | availability, cache, latency | yes | tree identical to `3722e7b9` (#86 on dev) | yes (via #86) | — | yes | SUPERSEDED | Review stack squash-merged as #86. |
| `origin/fix/az-01-deploy-runner` | `8ac0c73d` | 5 / 0 | 5 | `deploy.yml`, `publish-on-tag.yml`, CI tests | yes | those three files identical to `f29a58b2` (#85 on dev) | yes (via #85) | — | no | SUPERSEDED | Tailscale fail-closed + health discovery are inside #85. |
| `origin/fix/azure-gui-deploy-lane` | `158cc061` | 6 / 0 | 6 (1 unique) | `deploy.yml`, CI tests | yes | unique commit not on main or dev | yes (V6 GUI build gate) | none | no | KEEP | PR #90; one commit on top of `origin/dev` requiring a deployable GUI. |
| `origin/fix/ci-hygiene-audit` | `5624c012` | 7 / 19 | 7 | assorted workflows | yes | #56 (`dbcd8418`) + later main already pins timeouts/checkouts | no | — | no | SUPERSEDED | Stale vs main; unique pins already live. Remaining file diffs are main-ahead, not branch-ahead. |
| `origin/fix/cloudflare-workers-ai-livemodels` | `02c8f212` | 5 / 9 | 5 | registry, openai-chat, types, CLAUDE.md | no | `cc8d4227` cherry-eq `#68` (`590acd8e`); `liveModels: false` already on main | no | none | no | PARTIAL | Registry flag landed; four later commits still differ. |
| `origin/fix/gui-dashboard-live-bugs` | `1169f339` | 9 / 8 | 9 | GUI traffic, request-log, labels | yes | `0a1abc01` landed the bulk; tip still differs in Verkeer / traffic-row / traffic-shared | no | none | yes | PARTIAL | Keep the leftover traffic-label commits. |
| `origin/fix/gui-dashboard-live-bugs-v2` | `5d89c2de` | 4 / 9 | 4 | GUI traffic-display, request-log identity | yes | competing rewrite; `gui/src/traffic-display.ts` and `tests/request-log-identity.test.ts` are not on main | no | none | yes | KEEP | Alternate dashboard identity implementation; not the same tree as v1 or `0a1abc01`. |
| `origin/fix/live-claude-desktop-laptop-sync` | `b8a86b63` | 11 / 18 | 11 | live-checkout, desktop-3p, GUI Claude | yes | #66 (`03916957`); tip-to-tip of the branch files matches main except 4 lines of claude-code.md | yes (already live) | — | yes | SUPERSEDED | Review-hold stack is already in the #66 squash. |
| `origin/fix/oauth-402-hop-and-access-inject` | `bbb015c6` | 5 / 0 | 5 | availability 402, Access inject, docs | yes | content identical to `c5a2d15d` (#87) excluding later #85 deploy files | yes (via #87) | — | no | SUPERSEDED | Review stack squash-merged as #87. |
| `origin/fix/signaal-drift-cleanup` | `d8e81893` | 3 / 0 | 3 | GUI Signaal, fonts, depas.css | no | none | no | none | yes | KEEP | PR #88; unique Signaal-drift cleanup based on main, not on the availability stack. |
| `origin/r2-avail-unused-imports` | `66b8daa2` | 14 / 0 | 14 | availability (pre-squash) | yes | older parallel history of #76; origin/dev has the evolved module (`rate-limit-parse.ts` etc.) | yes (via #76) | — | yes | SUPERSEDED | Pre-squash of #76; leftover unused-import commit does not beat the landed squash. |
| `origin/r2-css-provider-shell` | `20705b09` | 17 / 0 | 17 | availability + shell CSS tokens | yes | same pre-squash plus CSS; origin/dev CSS already evolved (~60-line leftover) | yes (via #76) | — | yes | SUPERSEDED | Review-round CSS on an older availability stack. |
| `origin/r2-css-settings-catalog` | `11c38705` | 17 / 0 | 17 | availability + catalog CSS tokens | yes | sibling of `r2-css-provider-shell` (5 unique each way) | yes (via #76) | — | yes | SUPERSEDED | Parallel CSS experiment; availability landed via #76. |
| `origin/wip/usage-account-label` | `d7bd55d9` | 1 / 18 | 1 | usage label / request-log | yes | main already has a more complete `account` field + resolvers from later dashboard work | no | schema already evolved on main | no | EXPERIMENT | Explicit `wip:` commit; surface superseded on main. |

## Open pull requests

| PR | Head | Base | Unique vs main | Class | Why |
| --- | --- | --- | --- | --- | --- |
| #88 `fix(gui): Signaal-drift opruimen — depas-dialect, fonts, easing` | `origin/fix/signaal-drift-cleanup` (`d8e81893`) | `dev` | 3 | KEEP | Same as the branch row. Must be retargeted to `main` during `dev` retirement so the GUI cleanup is not lost. |
| #90 `fix(ci): require deployable OCX GUI` | `origin/fix/azure-gui-deploy-lane` (`158cc061`) | `dev` | 6 (1 unique on top of `origin/dev`) | KEEP | Same as the branch row. Depends on the 5 `origin/dev` commits; retarget to `main` only after those land, or keep stacked on the promotion PR. |

## PARTIAL — commits to retain

### `origin/feat/provider-fetch-models`

#65 (`68eb6a19`) already added per-provider Fetch models. Tip-to-tip, `gui/src/provider-workspace/refresh-models.ts` matches main. Remaining unique hunk is in `src/server/management/provider-routes.ts` (~19 lines) plus stale i18n (ignore — main is ahead).

Retain:

- `5296ac92` fix: Serialize provider model refreshes
- `82376159` fix: Disable model refresh for disabled providers
- `3e211b3f` fix(gui): Check fetch status before parsing refresh body
- `43147ade` Fix per-provider model refresh: success reporting, stale fallback, static providers
- `4af07c27` fix: Guard per-provider fetches with shared busy state
- `f12e862d` fix: Report unattempted live discovery as failure
- `9ec76d6e` fix: Resume deferred provider model fetch; Exclude native O

Drop: `2423abb7` (original feature; landed as #65).

### `origin/fix/cloudflare-workers-ai-livemodels`

Retain:

- `02c8f212` fix: Replace Node crypto with Bun hashing (`src/adapters/openai-chat.ts`)
- `510805ea` fix: Normalize chat tool names consistently
- `bc4c6925` fix: Normalize MCP namespace map keys
- `8732fede` chore: opencodex adapter/types update + CLAUDE.md

Drop: `cc8d4227` (cherry-equivalent to #68; `liveModels: false` already on main).

### `origin/fix/gui-dashboard-live-bugs`

`0a1abc01` landed the dashboard/traffic/provider-label bulk. Tip-to-tip leftovers are `gui/src/pages/Verkeer.tsx`, `gui/src/traffic-row.tsx`, `gui/src/traffic-shared.ts` (~18 lines).

Retain:

- `1169f339` fix: Expose traffic column labels
- `34512e73` fix: Normalize account-suffixed providers; Restore localize
- `8eb0cd2a` fix: Add responsive traffic grid layout

Drop the rest (`b3ef0141` and the requestId / docstring review chain) — already in `0a1abc01`.

## KEEP — why these must not be dropped

| Ref | Why |
| --- | --- |
| `origin/main` | Trunk. |
| `origin/dev` | Five unreleased commits, including production deploy retarget (#85) and the Availability module (#76). |
| `origin/fix/azure-gui-deploy-lane` / PR #90 | Closes the live GUI-build hole (snapshot V6). |
| `origin/fix/signaal-drift-cleanup` / PR #88 | Unique frontend cleanup, based on main, not absorbed by #89. |
| `origin/fix/gui-dashboard-live-bugs-v2` | Unique `traffic-display` module and request-log identity tests; competing with v1 leftovers. A human should pick v1 leftovers vs v2 before merge. |

## Archive tags

Exact unexecuted commands for EXPERIMENT / DEAD / SUPERSEDED heads are in
the Archive policy section of `DEV_RETIREMENT.md`. Nothing in this
document authorizes deleting a branch before that tag exists.
