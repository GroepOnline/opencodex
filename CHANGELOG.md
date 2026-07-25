# Changelog

All notable changes to the OnlineChefGroep fork of **opencondex** are documented here.

**Repository:** [OnlineChefGroep/opencodex](https://github.com/OnlineChefGroep/opencodex)  
**Package:** `@bitkyc08/opencodex`

> This fork uses **independent semantic versioning** starting at v1.0.0.  
> See [VERSIONING.md](./VERSIONING.md) for details.

---

## [1.0.0] — Fork inaugural release

*No release yet.*  
Next release will mark the first independent fork version.

### Merged since fork

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

- **Independent versioning** — fully detached from upstream with our own scheme.
- **Enhanced CI** — added security audit, CodeQL analysis, GitHub Actions linting.
- **Dependabot** — automated weekly dependency updates.
- **Release documentation** — VERSIONING.md and RELEASE_PROCESS.md for easy releases.

---

## Earlier versions (upstream tracking)

Versions v2.7.26 through v2.7.39 (and earlier) track the upstream
[lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) releases.
