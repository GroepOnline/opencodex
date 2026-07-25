# Roadmap

**Independent OnlineChefGroep fork** of [opencodex](https://github.com/lidge-jun/opencodex)

## Vision

A fully self-sufficient fork with our own release cadence, feature set, and quality bar —
not dependent on upstream decisions or timelines, while retaining a deliberate intake path for
relevant security and compatibility fixes.

## Short term (done)

- [x] **Independent versioning** — fully detached from upstream version numbers, with our own semver scheme
- [x] **Integrated inherited branch work** — Dutch GUI, Claude Desktop, combo/alias, Cursor fixes, and related stacked work reconciled into `main`
- [x] **Enhanced CI** — CodeQL, Dependabot, security audit, workflow linting, and cross-platform package smoke tests
- [x] **Release process** — `VERSIONING.md`, `RELEASE_PROCESS.md`, and `CHANGELOG.md`
- [x] **Fork identity documentation** — canonical repository links and translated README fork notices updated

## Near term (next)

- [ ] **Publish first fork release (`v1.0.0-alpha.1`)** — tag, run the guarded release workflow, verify npm install, and record release evidence
- [ ] **Canonical npm ownership** — migrate the package to an OnlineChefGroep-controlled npm scope and retain a compatibility path for `@bitkyc08/opencodex`
- [ ] **Clean up old tags** — remove or archive stale upstream tags that do not identify fork releases
- [ ] **Dependency audit hardening** — review root and GUI dependencies, then make high-severity audit failures enforceable instead of informational
- [ ] **TypeScript strict mode** — enable `strict` in `tsconfig` and fix all violations
- [ ] **Upstream intake policy** — document how security, protocol, and client-compatibility fixes are evaluated and imported without restoring release dependence

## Medium term

- [ ] **Custom provider: OnlineChef AI gateway** — first-party provider integration
- [ ] **Performance benchmarks** — proxy latency regression tests in CI
- [ ] **Improved documentation** — deploy docs to GitHub Pages for the fork
- [ ] **Automated dependency upgrades** — Dependabot auto-merge for verified non-breaking updates
- [ ] **Smoke test suite** — end-to-end tests that start the proxy and exercise real provider-compatible requests

## Long term

- [ ] **Own GUI theme** — custom branding for the dashboard
- [ ] **Plugin system** — third-party provider adapters
- [ ] **Service mode improvements** — better systemd/launchd integration
- [ ] **Multi-host fleet management** — centralized config across machines
