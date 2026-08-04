# Roadmap

Roadmap for [GroepOnline/opencodex](https://github.com/GroepOnline/opencodex).

## Vision

A fully self-sufficient fork with our own release cadence, feature set, and quality bar —
no longer dependent on upstream decisions or timelines.

## Short term (done)

- [x] **Independent versioning** — fully detached from upstream, own semver scheme
- [x] **All closed PRs merged** — Dutch GUI, Claude Desktop, combo/alias, cursor fixes, etc.
- [x] **Enhanced CI** — CodeQL, dependabot, security audit, workflow linting
- [x] **Release process**: main-only publishing via `.github/workflows/release.yml`
      and `scripts/release.ts`, with review and promotion policy in `MAINTAINERS.md`

## Near term (next)

- [ ] **First fork release (`2.7.43`)**: publish from `main` on npm dist-tag `latest`
      (prereleases use `X.Y.Z-preview.N` and ship on `preview`)
- [ ] **Release documentation**: add `VERSIONING.md`, `RELEASE_PROCESS.md`, and
      `CHANGELOG.md` for the fork's release model
- [ ] **Update READMEs** — ensure all translated READMEs (ko, zh, ru, ja) reflect fork status
- [ ] **Clean up old tags** — remove stale upstream tags that don't point to our commits
- [ ] **Dependency audit** — review and update all dependencies (gui + root)
- [ ] **TypeScript strict mode** — enable `strict` in tsconfig and fix all violations

## Medium term

- [ ] **Custom provider: OnlineChef AI gateway** — first-party provider integration
- [ ] **Performance benchmarks** — proxy latency regression tests in CI
- [ ] **Improved documentation** — deploy docs to GitHub Pages for our fork
- [ ] **Automated dependency upgrades** — Dependabot auto-merge for non-breaking updates
- [ ] **Smoke test suite** — end-to-end tests that spin up the proxy and make real API calls

## Long term

- [ ] **Own GUI theme** — custom branding for the dashboard
- [ ] **Plugin system** — third-party provider adapters
- [ ] **Service mode improvements** — better systemd/launchd integration
- [ ] **Multi-host fleet management** — centralized config across machines
