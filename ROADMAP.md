# Roadmap

**Independent OnlineChefGroep fork** of upstream opencodex
([lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) as historical source;
canonical product work lives in [OnlineChefGroep/opencodex](https://github.com/OnlineChefGroep/opencodex)).

For the full audit + phased execution plan, see
[`structure/09_x10-terminal-plan.md`](structure/09_x10-terminal-plan.md).

## Vision

A fully self-sufficient fork with our own release cadence, feature set, and quality bar —
not dependent on upstream decisions or timelines, while retaining a deliberate intake path for
relevant security and compatibility fixes. The operator “terminal” (CLI + GUI + proxy) should
feel 10× less frictional than stock upstream for ChefGroep kitchens.

## Short term (done)

- [x] **Fork repository + branch model** — OnlineChefGroep remote; `dev` integration; `main` release
- [x] **Inherited product work on lines** — Dutch/ChefGroep GUI language, Claude Desktop, combos/aliases, Cursor fixes (verify per-branch; reconcile still open)
- [x] **Cross-platform package smoke in CI** — Linux/macOS/Windows package smoke job
- [x] **Infrastructure lanes started on `dev`** — plugins contract (#40), Prometheus metrics (#42), admission rate-limit (#44/#45), ChefVault provider-security (#38)

## Near term (next) — Phase 0–1 of x10 plan

- [ ] **Merge open train** — #51 CI shards → #53 Claude recursive OCX → #52 rate-limit metrics (undraft)
- [ ] **Reconcile `dev` ↔ `main`** — diverged (~222 ahead / ~43 behind); one coherent line before release
- [ ] **CI hardening** — Dependabot config, security audit job, actionlint (not yet present on `dev`)
- [ ] **Release docs scaffolding** — `VERSIONING.md`, `RELEASE_PROCESS.md`, `CHANGELOG.md` (not yet present)
- [ ] **Publish first fork release (`v1.0.0-preview.1`)** — tag from reconciled `main`, guarded release workflow, npm install evidence
- [ ] **Canonical npm ownership** — OnlineChefGroep-controlled scope + compatibility path for `@bitkyc08/opencodex`
- [ ] **Docs Pages for the fork** — deploy docs-site with OnlineChefGroep URLs (not upstream domain assumptions)
- [ ] **Upstream intake policy** — security/protocol/client-compat only; no release dependence
- [ ] **ROADMAP/docs truth pass** — drop false claims (e.g. CodeQL “done” without workflow; strict already enabled)

## Medium term — Phase 2–4

- [ ] **Terminal UX 10x** — guided `ocx init`, `doctor --fix`, observe cockpit, help IA
- [ ] **De Pas / control-plane GUI** — wire fleet shell under ChefGroep skins; metrics + rate-limit visibility
- [ ] **Custom provider: OnlineChef AI gateway** — first-party registry preset
- [ ] **ChefVault operator UX** — degraded-mode clarity when vault tunnel is down
- [ ] **Smoke test suite** — start proxy + fixture provider requests in CI
- [ ] **Benchmark harness** — latency/artifact lane after APIs stabilize
- [ ] **Config diagnostics** — enhance `ocx config validate` (no second validator)

## Long term — Phase 5

- [ ] **Multi-host fleet management** — centralized config / status across machines
- [ ] **Service mode improvements** — systemd/launchd/WinSW parity
- [ ] **Plugin system (beyond observational contract)** — only with explicit security model; no arbitrary FS loaders by default
- [ ] **Performance regression gates** — p95 TTFT / proxy overhead in CI after baselines
