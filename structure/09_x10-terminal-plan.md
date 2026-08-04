# 09 — Full Audit + x10 Terminal Plan (GroepOnline)

Status: living execution plan for the GroepOnline fork of opencodex (`ocx`).
Authored from a full-repo audit on 2026-08-02. Targets `dev` as the integration
branch unless a step is explicitly a `main` promotion.

## What “terminal x10” means here

opencodex is the local control plane for Codex / Claude Code / Grok Build. The
“terminal” is the whole operator surface: `ocx` CLI, doctor/observe loops, GUI
(“De Pas” / ChefGroep instrument), and the proxy that keeps nested agent CLIs
routed through OCX. 10x is not “10× more providers” — it is 10× less friction
from install → first successful routed turn → trustworthy ops at kitchen scale.

---

## A. Audit snapshot (current state)

### Product shape

| Layer | State on `dev` | Notes |
| --- | --- | --- |
| Runtime proxy | Mature | Bun-native; Responses + Claude Messages + images; adapters for 60+ presets |
| CLI (`ocx`) | Wide but uneven | ~30 command families; init/doctor/observe exist; little personality or guided recovery |
| GUI | ChefGroep skin landed (#30) | Warm Devin / Strak skins; nl default; De Pas WIP pages live on `main` only, unwired |
| Observability | Partial | Prometheus metrics (#42); rate-limit admission (#44/#45); projection PR #52 open |
| Plugins | Contract only | Observational lifecycle (#40); no dynamic loaders; ROADMAP still lists plugins as long-term |
| Provider security | ChefVault slots (#38) | Per-request credentials; vault tunnel outages are an external dependency |
| Fork identity | Split brain | `dev` @ 2.7.43; `main` still carries 2.7.42 + unfinished `v1.0.0-alpha.1` attempt |

### Branch divergence (highest systemic risk)

| Metric | Value |
| --- | --- |
| `dev` ahead of `main` | ~222 commits |
| `dev` behind `main` | ~43 commits |
| Relationship | **Diverged** (not fast-forwardable) |

`main`-only value to preserve on intake: upstream OmniRoute / provider parity
fixes, PostHog + budget/latency experiments, De Pas page stubs, any release-
identity commits that still apply after rebase.

`dev`-only value that must not be lost: rate-limit, metrics, plugins contract,
ChefVault provider-security, GUI redesign + en/nl i18n, accounts workspace.

Until this is reconciled, every release and every “ship x10” claim is blocked.

### Strengths to keep

1. Maintainer SOT in `structure/` with explicit invariants.
2. Single provider registry + parity tests.
3. Deep cross-platform test suite (~390 root test files + GUI tests).
4. Clean adapter → `bridge.ts` boundary.
5. Operational primitives: doctor, usage JSONL, startup health, restore-on-stop.
6. Multi-client: Codex + Claude Code + Claude Desktop + Grok.

### Debt / risk hotspots

| Hotspot | Why it matters |
| --- | --- |
| `src/server/responses/core.ts` (~2k LOC) | Central path; hard to change safely |
| Cursor / Kiro adapters | Largest adapter complexity |
| `dev` ↔ `main` divergence | Blocks first fork release |
| ROADMAP vs reality | Claims CodeQL / strict / GUI theme done or pending incorrectly |
| Dead De Pas pages on `main` | Brand work without routing |
| Windows CI ~13 min | Near timeout without #51 sharding |
| Docs / package URLs | Residual upstream residue on some branches |
| No real e2e smoke | ROADMAP item still open |
| ChefVault dependency | Provider-security degrades when vault tunnel is down |

---

## B. Open PR pickup (executed 2026-08-02; completed 2026-08-03)

**Superseded — no open actions remain.** The train merged to `dev` on
2026-08-03 (see Phase 0 item 1). Kept for the record:

| Pri | PR | Action taken | Outcome |
| --- | --- | --- | --- |
| 1 | [#51](https://github.com/GroepOnline/opencodex/pull/51) CI shard | Rebased onto `dev`; Greptile thread resolved; merge-ready comment | ~~Security sign-off on workflow → merge~~ **Merged 2026-08-03** |
| 2 | [#53](https://github.com/GroepOnline/opencodex/pull/53) Claude recursive OCX | Stale P1/trivial threads resolved; CI green | ~~Merge~~ **Merged 2026-08-03** |
| 3 | [#52](https://github.com/GroepOnline/opencodex/pull/52) rate-limit metrics | Threads resolved; still **draft** | ~~Undraft → review → merge~~ **Undrafted and merged 2026-08-03** |

No code conflicts between these three. #51 first protected CI for everything else.

---

## C. x10 execution plan

Six phases. Each phase has an exit gate. Do not start the next phase until the
gate is green. All implementation PRs target `dev`; promotion to `main` is a
maintainer-controlled release step.

### Phase 0 — Stabilize the train (unblocks everything)

**Goal:** One coherent integration line and reliable CI.

1. ~~Merge #51 → #53 → #52 in that order.~~ Done 2026-08-03; all open PRs (#51–#61) merged to `dev`.
2. ~~Reconcile `main` → `dev`~~ Done via #55 (Codex pacer port); non-ports documented in `structure/10_dev-main-reconcile.md`. De Pas stubs stay until Phase 3.
3. Update required CI checks for new shard job names (`macos-quality`, `windows-quality`, `windows-latest shard 2/2`). — **No-op for now:** no branch protection rule is configured (see `MAINTAINERS.md`), so there are no required checks to update in GitHub; apply these names when protection is set up.
4. ~~Fix ROADMAP truth~~ Done 2026-08-03: near-term list updated to match `dev` (CodeQL absent and unclaimed; `tsconfig.json` strict already on).

**Exit gate:** `dev` contains all fork-critical work; CI green under sharded Windows; ROADMAP matches reality; no orphan De Pas files without owners.

### Phase 1 — Ship the fork identity (trust ×10 for install)

**Goal:** A stranger can install GroepOnline ocx and know it is ours.

1. Publish `v1.0.0-preview.1` from reconciled `main` (release workflow + evidence in CHANGELOG). The release contract (`scripts/release.ts`, `release.yml`) only accepts prereleases shaped `X.Y.Z-preview.N` on the `preview` dist-tag; `-alpha` versions are rejected before publication.
2. Canonical npm scope under GroepOnline control; keep the legacy `@bitkyc08/opencodex` compatibility path documented.
3. Align `package.json` / README / docs-site / star-prompt / update URLs on both branches.
4. Deploy fork docs to GitHub Pages (replace upstream `opencodex.me` assumptions).
5. Upstream intake policy doc (security/protocol only; no release dependence).
6. Enforce high-severity `bun audit` (already claimed on some histories — verify on `dev`).

**Exit gate:** `npm i -g <our-scope>/opencodex@preview` works on Linux/macOS/Windows without preinstalled Bun; docs and update notifier point only at GroepOnline.

### Phase 2 — Terminal UX 10x (CLI + guided recovery)

**Goal:** First successful routed turn in minutes; failures become actionable.

This is the core “terminal x10” phase.

| Workstream | Concrete deliverables |
| --- | --- |
| **Guided `ocx init`** | Design-first wizard (structure/07 dials): auth-kind stages, Dutch/EN voice, OnlineChef gateway as first-class preset when ready |
| **Doctor → fix loops** | `ocx doctor --fix` for safe auto-repairs (shim, catalog inject, port conflict, vault degraded mode messaging) |
| **Observe as cockpit** | Unify `observe logs`, `observe usage`, and `observe memory` into one TUI-friendly status strip + JSON for agents |
| **Claude/Codex spawn reliability** | Land #53; add e2e regression for nested `claude` + Agent View; document recursive PATH rules |
| **Star/update noise** | Keep star prompt opt-in; make update notify fork-correct and quiet by default |
| **Help IA** | Restructure `ocx help` into lifecycle / providers / observe / integrations; drop dead aliases |

**Exit gate:** Timed cold-start scenario (clean home → init → start → one mock Responses turn) documented and covered by an e2e-style test; doctor can repair the top 5 failure modes without reading source.

### Phase 3 — Control-plane 10x (GUI “De Pas” + ops)

**Goal:** The dashboard feels like ChefGroep infrastructure, not a generic admin template.

1. Wire or rebuild fleet shell pages (Modellen / Verkeer / Systeem / Instellingen) on `dev` under the existing ChefGroep skins — one composition language, no card soup.
2. Surface metrics + rate-limit aggregates (#52) in GUI: allow/deny, surface breakdown, no identity leakage.
3. Provider workspace: ChefVault slot status, degraded-mode banners, per-provider fallback already started in #36.
4. Claude + Codex auth pages: single “accounts” mental model (already generalized — finish consistency).
5. Strict i18n: en source complete; nl overrides for operator voice; drop unused locale residue.

**Exit gate:** Operator can answer “is the kitchen proxy healthy, who is rate-limited, and which vault slots are live?” from the GUI in under 10 seconds.

### Phase 4 — Platform 10x (gateway, plugins, security)

**Goal:** OnlineChef-native differentiation without forking the adapter model.

1. **OnlineChef AI gateway** provider preset (registry + adapter path + docs).
2. **ChefVault** hardening: offline/degraded UX, doctor checks, no secret logging (privacy:scan green).
3. **Plugins v1 → useful:** first-party observational plugins (metrics already separate; example: budget alert, PostHog projection) registered in-process — still no arbitrary FS loaders.
4. Finish structure plan leftovers: config diagnostics enhancements; benchmark harness (#5 in plugin-metrics plan).
5. Smoke suite: start proxy + fixture provider Responses + Claude Messages in CI.

**Exit gate:** One OnlineChef-branded provider path works end-to-end; plugins/metrics/rate-limit/benchmark lanes marked complete in `structure/plugin-metrics-ratelimit-benchmarks.md`.

### Phase 5 — Scale 10x (fleet + reliability)

**Goal:** Multi-machine kitchens without babysitting.

1. Multi-host fleet management (config sync, admission keys, read-only status aggregation).
2. Service mode improvements (systemd/launchd/WinSW parity + lifecycle workflow always green).
3. Performance budgets: p95 TTFT / proxy overhead regression gates after baseline week.
4. Optional Go native-port intake only if upstream `dev2-go` proves install-size wins — not a fork priority until Phase 1–4 land.

**Exit gate:** Documented fleet of ≥2 hosts managed from one control surface; CI blocks on latency regression beyond agreed budget.

---

## D. Priority matrix (what moves the needle)

| Lever | Impact | Invasiveness | Phase |
| --- | --- | --- | --- |
| Merge open PRs + fix CI shards | High | Low | 0 |
| Reconcile `dev`/`main` | Critical | High | 0 |
| First alpha release + npm identity | High | Medium | 1 |
| Doctor--fix + init redesign | Very high | Medium | 2 |
| Claude recursive routing (#53) | High | Low | 0/2 |
| De Pas / metrics GUI | High | Medium | 3 |
| OnlineChef gateway + Vault UX | Differentiating | Medium–High | 4 |
| Fleet multi-host | Strategic | High | 5 |

---

## E. Non-goals (explicit)

- Do not reintroduce dynamic plugin code loading from arbitrary paths.
- Do not log prompts, API keys, or account identifiers.
- Do not target `main` for feature PRs.
- Do not claim “independent versioning done” until alpha is actually published.
- Do not copy generated “improvement bundles” that duplicate config/cost systems (see plugin-metrics plan).

---

## F. Linear packaging (created 2026-08-02)

| Phase | Linear | URL |
| --- | --- | --- |
| 0 Stabilize | [CHE-5](https://linear.app/chefgroepp/issue/CHE-5/ocx-0-stabilize-train-merge-515352-reconcile-devmain) | Urgent / Todo |
| 1 Identity | [CHE-6](https://linear.app/chefgroepp/issue/CHE-6/ocx-1-ship-fork-identity-alpha-release-npmdocs) | High / Backlog (child of CHE-5) |
| 2 Terminal UX | [CHE-9](https://linear.app/chefgroepp/issue/CHE-9/ocx-2-terminal-ux-10x-init-doctor-fix-observe-help) | High / Backlog |
| 3 Control plane | [CHE-10](https://linear.app/chefgroepp/issue/CHE-10/ocx-3-control-plane-de-pas-gui-metrics-visibility) | Medium / Backlog |
| 4 Platform | [CHE-8](https://linear.app/chefgroepp/issue/CHE-8/ocx-4-platform-gateway-vault-ux-plugins-completion-smoke) | Medium / Backlog |
| 5 Scale | [CHE-7](https://linear.app/chefgroepp/issue/CHE-7/ocx-5-scale-fleet-service-parity-latency-gates) | Low / Backlog |

Each phase opens as a stacked PR series against `dev`.

---

## G. Immediate next commands (operators)

The #51/#53/#52 merge commands and the Phase 0 reconcile branch that used to
live here are done (train merged 2026-08-03; reconcile landed via #55). Current
next step is Phase 1 (fork identity release).

Validation on every runtime PR (single command; runs typecheck, GUI lint, tests, privacy scan, and the GUI doctor gate):

```bash
bun run prepush
```
