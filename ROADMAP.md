# OpenCodex roadmap

Status: updated 2026-10-14 against `GroepOnline/opencodex/main` at `52bc938f2c5e`. This file tracks **merged source**, **published artifacts**, and **live acceptance** separately. Historical August 2026 plans are in [structure/09_x10-terminal-plan.md](structure/09_x10-terminal-plan.md); `main` is the sole integration branch since 2026-10-01.

## Product direction

One independent, local-first model gateway with explicit provider/account boundaries, optional client integrations and an accessible, component-driven operator GUI. The goal is reliable, low-friction setup and diagnosis, not a provider-count marketing metric. Native third-party clients and provider entitlements remain independent.

## Verified milestones

- [x] **Release v1.5.5**: [GitHub Release](https://github.com/GroepOnline/opencodex/releases/tag/v1.5.5) published 2026-10-14 01:33:49 UTC from tag commit `fb7d3a130257b9542b5adc10b740baf4c1a78c8a`. The release notes report npm `@groeponline/opencodex@1.5.5` with dist-tag `latest`. The published release includes the first `ocx droid` launcher (#354), custom reasoning efforts (#347), external Codex sync truthfulness (#357), and README correction (#356).
- [x] **Main-only Factory hardening (#355)**: merged 2026-10-14 01:56:30 UTC, commit `3ddbd9a33240cea90964f917a3ba073c71f69353`. Source-level tests cover stable custom-model identities, preservation of existing custom models, data-plane admission isolation, and explicit discovery failures. **Not part of v1.5.5**, and not a real installed-Factory acceptance test.
- [x] **Main-only Claude Desktop hardening (#349)**: merged 2026-10-14 02:09:41 UTC, commit `52bc938f2c5eddda5cee44f16c4f542009d034b9`. Provides `ocx claude desktop doctor [--json]`, scoped protocol cleanup, private bounded backups and cross-process library locking. **Not part of v1.5.5**.
- [x] **Retired `dev` branch**: all new work targets `main`, through normal branch/PR/CI/review controls. Source merge, package publication, docs deployment, and running machines are four different evidence boundaries.
- [x] **Cross-platform CI and source release contracts** exist. Green source-level CI does not by itself demonstrate provider credentials, vendor-client compatibility, end-to-end inference, or deploy parity.

## Active work — not shipped or accepted

- [ ] **GUI vNext, real components and structure**: [#358](https://github.com/GroepOnline/opencodex/pull/358) (draft typed navigation and route outlet) and [#359](https://github.com/GroepOnline/opencodex/pull/359) (draft feature-scoped Usage components) are independent implementation slices. Continue feature ownership and reusable shadcn/Base UI primitives; avoid page-sized monolithic TSX and decorative abstraction. Neither draft is a shipped redesign.
- [ ] **Whole-product i18n**: typed locale keys, no hardcoded new user-facing strings, CI i18n lint on migrated folders, keyboard/screen-reader parity and no untranslated fallback drift. Current route-based tests and NL/EN coverage do not prove every surface is internationalized.
- [ ] **Motion and visual quality**: intentional page/element transitions with reduced-motion, performance, touch and mobile testing; no one-shot reskin or AI-template look. Require screenshot/browser parity before claiming completion.
- [ ] **Factory Droid real acceptance**: run against an installed vendor CLI with existing `customModels`, merged settings, environment-based admission, model selection and a real routed turn; capture exact version, health, secret-safety, cleanup and rollback-free failure behavior. Tests in [#355](https://github.com/GroepOnline/opencodex/pull/355) model vendor merge behavior but do not replace this runtime gate.
- [ ] **Claude Desktop real acceptance**: prove profile apply/sync, a concurrent writer, XDG default recognition, `doctor --json`, uninstall ownership and reload on supported hosts. Unit tests from #349 prove source invariants, not live desktop adoption.
- [ ] **Public docs reachability**: verify an unauthenticated request to `opencodex.chefgroep.online` and the intended Cloudflare Access policy. An earlier 403 was observed; no fresh edge result is asserted by this roadmap.
- [ ] **Autoresearch harness (#334)**: draft and isolated; the benchmark guard cannot convert noisy measurements into correctness evidence without repeated samples, frozen fixtures and all required CI.
- [ ] **Release follow-through**: tag/npm/GHCR artifacts, immutable provenance, exact-head CI and production health are independent gates. Never advertise post-tag commits as capabilities of v1.5.5.

## Later priorities

- [ ] Guided `init`, diagnostic `doctor` recovery, observable startup and clear account/capacity errors; validate without another parallel configuration validator.
- [ ] De Pas fleet/management UX with explicit authorization and security boundaries; improve dashboard visibility without broadening credential access.
- [ ] First-party OnlineChef provider preset, ChefVault outage clarity and portable provider bridge contracts.
- [ ] Deterministic proxy+fixture e2e smoke CI, latency/cold-start/CI-shard baselines and performance regression gates.
- [ ] Multi-host fleet coordination and macOS/Linux/Windows service parity.
- [ ] Dynamic plugin execution only after a documented trust model and isolation review. The existing observational plugin contract is not an arbitrary filesystem plugin loader.

## Evidence and learning

See [docs/adr/0008-client-integration-evidence-2026-10-14.md](docs/adr/0008-client-integration-evidence-2026-10-14.md) for root causes, regression tests, reviewbot handling and release-boundary lessons. Keep historical findings in `docs/`; update `docs-site/` for actual user-facing behavior, `structure/` for maintained invariants, and this roadmap for current delivery state.
