# Roadmap

**Independent GroepOnline fork** of upstream opencodex
([lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) as historical source;
canonical product work lives in [GroepOnline/opencodex](https://github.com/GroepOnline/opencodex)).

For the full audit + phased execution plan, see
[`structure/09_x10-terminal-plan.md`](structure/09_x10-terminal-plan.md).

## Vision

A fully self-sufficient fork with our own release cadence, feature set, and quality bar —
not dependent on upstream decisions or timelines, while retaining a deliberate intake path for
relevant security and compatibility fixes. The operator “terminal” (CLI + GUI + proxy) should
feel 10× less frictional than stock upstream for ChefGroep kitchens.

## Short term (done)

- [x] **Fork repository + branch model** — GroepOnline remote; `main` is the sole integration line; the former `dev` branch was retired on 2026-10-01
- [x] **Inherited product work reconciled** — Dutch/ChefGroep GUI language, Claude Desktop, combos/aliases, Cursor fixes, and the component-driven GUI slices are on `main`
- [x] **Cross-platform package smoke in CI** — Linux/macOS/Windows package smoke job
- [x] **Infrastructure lanes landed** — plugins contract (#40), Prometheus metrics (#42), admission rate-limit (#44/#45), ChefVault provider-security (#38)

## Near term (next) — Phase 0–1 of x10 plan

- [x] **Merge open train** — #51 CI shards → #53 Claude recursive OCX → #52 rate-limit metrics; all open PRs (#51–#61) merged to `dev` on 2026-08-03
- [x] **Reconcile `dev` ↔ `main`** — Codex pacer ported via #55; non-ports documented in [`structure/10_dev-main-reconcile.md`](structure/10_dev-main-reconcile.md) (De Pas stubs stay until Phase 3)
- [x] **CI hardening** — `.github/dependabot.yml`, Security audit job (both lockfiles), pinned actionlint job on `dev` (#60)
- [x] **Release docs scaffolding** — `VERSIONING.md`, `RELEASE_PROCESS.md`, and `CHANGELOG.md` are live and the release workflow is contract-tested
- [x] **Publish fork releases** — the original preview milestone was superseded; stable `v1.5.1` is published to npm, GitHub Releases, GHCR, and Homebrew with artifact provenance pinned to `f7341fac`
- [x] **Canonical npm ownership** — `@groeponline/opencodex` is the canonical published package; npm `latest` is `1.5.1` and release/install automation targets the GroepOnline scope
- [ ] **Docs Pages public edge** — the GitHub Pages deploy workflow is green and the ChefGroep hostname is configured, but an unauthenticated probe of `opencodex.chefgroep.online` currently returns Cloudflare `403`; resolve the intended public/Access policy before calling the docs surface complete
- [ ] **Upstream intake policy** — security/protocol/client-compat only; no release dependence
- [x] **ROADMAP/docs truth pass** — refreshed against `main` on 2026-10-03; release/distribution state above reflects the verified `v1.5.1` artifact and the retired `dev` line

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
