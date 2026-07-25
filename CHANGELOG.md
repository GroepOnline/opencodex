# Changelog

All notable changes to the OnlineChefGroep fork of **opencodex** are documented here.

**Repository:** [OnlineChefGroep/opencodex](https://github.com/OnlineChefGroep/opencodex)  
**Package:** `@bitkyc08/opencodex`

> This fork uses **independent semantic versioning** starting at `v1.0.0-alpha.1`.  
> See [VERSIONING.md](./VERSIONING.md) for details.

---

## [1.0.0-alpha.1] — Planned inaugural fork pre-release

Prepared as the first independent fork release, fully detached from upstream release numbering.

### Added

- **Claude Desktop integration** — full Claude Desktop profile management via GUI and CLI
- **Combo rename & public aliases** — rename combos and expose public aliases
- **Output defaults & web-search replay markers** — custom output defaults
- **Response item ID repair** — opt-in repair for unstable passthrough IDs
- **Cursor context usage** — accurate context usage reporting across tool turns
- **Cursor cache telemetry** — clarify missing cache telemetry with GUI indicators
- **Native effort clamp** — gate native effort clamp by route identity
- **Dutch GUI localization** — full Dutch translation for the dashboard
- **Provider workspace shell** — dedicated dashboard panel for per-provider workspace
- **Quota bars** — visual quota display in the dashboard

### Changed

- **Independent versioning** — detached from upstream version numbers with the fork's own semver scheme
- **CI pipeline** — enhanced with CodeQL, Dependabot, security audit, workflow linting, and cross-platform package smoke tests
- **Canonical fork references** — active project, release, documentation, and support URLs point to OnlineChefGroep; historical upstream links remain where attribution or tracking requires them
- **Release workflow** — adapted for the fork's main-branch release model and prerelease tags

### Fixed

- Theme state: properly read `ocx-theme` from localStorage
- Stale theme button: React state now updates on theme selection
- Legacy hash links: restore `#combos`, `#subagents`, `#debug`, `#usage` routing
- Merge conflict markers removed from Claude Desktop i18n files

### Integrated since fork

- **Claude Desktop integration** — full Claude Desktop profile management via GUI and CLI, family
  editor, health monitoring, auto-apply, and effort transparency.
- **Combo rename & public aliases** — rename combos and expose public aliases for model routing.
- **Output defaults & web-search replay markers** — custom output defaults and hide web-search
  replay markers.
- **Response item ID repair** — opt-in repair for unstable passthrough IDs.
- **Cursor context usage** — accurate context usage reporting across tool turns.
- **Cursor cache telemetry** — clarify missing cache telemetry with GUI indicators.
- **Native effort clamp** — gate native effort clamp by route identity.
- **Native OpenAI slugs in combo resolution** — include native OpenAI slugs in combo member
  resolution.
- **Adaptive thinking headroom** — preserve adaptive thinking output headroom for Anthropic.
- **Sidecar auth fixes** — verify direct helper auth origin, explicit ChatGPT auth intent.
- **Dutch GUI localization** — full Dutch translation for the dashboard.
- **Provider workspace shell** — dedicated dashboard panel for per-provider workspace.
- **Quota bars** — visual quota display in the dashboard.
- **Theme state fix** — properly read `ocx-theme` from localStorage.
- **Stale theme button fix** — update React state on theme selection.
- **Legacy hash link targets** — restore `#combos`, `#subagents`, `#debug`, `#usage` routing.

### Infrastructure

- **Independent versioning** — fully detached from upstream release numbering.
- **Enhanced CI** — added security audit, CodeQL analysis, GitHub Actions linting, and package-install smoke coverage.
- **Dependabot** — automated weekly dependency updates.
- **Release documentation** — `VERSIONING.md` and `RELEASE_PROCESS.md` for repeatable releases.

---

## Earlier versions (upstream tracking)

Versions `v2.7.26` through `v2.7.39` (and earlier) track the upstream
[lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) releases.
