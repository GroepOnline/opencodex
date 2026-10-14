# ADR 0008 — Client-integration evidence and regression boundaries (2026-10-14)

Status: accepted as a source-level regression record for the merged PRs; runtime acceptance remains open. This is a historical technical record, not a claim about npm, released binaries or live vendor clients.

## Evidence boundary

- GitHub Release [v1.5.5](https://github.com/GroepOnline/opencodex/releases/tag/v1.5.5) was published at 2026-10-14 01:33:49 UTC from tag commit `fb7d3a130257b9542b5adc10b740baf4c1a78c8a`.
- [PR #355](https://github.com/GroepOnline/opencodex/pull/355) merged at 01:56:30 UTC as `3ddbd9a33240cea90964f917a3ba073c71f69353`.
- [PR #349](https://github.com/GroepOnline/opencodex/pull/349) merged at 02:09:41 UTC as `52bc938f2c5eddda5cee44f16c4f542009d034b9`.
- Therefore #355 and #349 are **main-only**, not features of published v1.5.5. Exact-head green CI, release artifacts, and installed client behavior require separate receipts.

## Factory Droid — #355

Problem: a generated client custom-model overlay could be treated as a replacement for user settings and could blur Codex Direct / OCX admission identity. Fix: preserve stable scoped model IDs and explicit data-plane admission through an environment reference; never embed the management credential in a settings overlay. Discovery now distinguishes denied (401), proxy failure (503), malformed catalog and transport failure from an actually empty catalog without reflecting confidential response bodies.

Regression guards:
- `tests/cli-droid-model-retention.test.ts`: 117 existing custom models, stable IDs, nested metadata and settings, modeled ID-keyed merge semantics.
- `tests/cli-droid-admission.test.ts`: isolated OCX credential reference, no management-token leak, no unnecessary mutation of caller environment.
- `tests/cli-droid.test.ts`: 401/503/malformed catalog/network-error diagnostics.
- `tests/codex-shim-autorestore.test.ts`: the Droid launcher must not trigger native Codex repair.

**Not proven by these tests:** an installed Factory CLI actually merging `--settings` with existing `customModels`, preserving selected model across sessions, or completing an upstream turn. Do not resolve this gate from fixture success alone.

## Claude Desktop — #349

Problem: registration ownership, secret-bearing backups and concurrent apply/sync could diverge. A pre-network metadata snapshot could become stale before a locked write. Fix: shared cross-process library lock, metadata read inside the critical section, protected 0600 atomic backups limited to three newest pre-sync copies, owned protocol cleanup and a read-only `ocx claude desktop doctor [--json]`. Unknown XDG default status is a **warning**, not success.

Regression guards:
- `tests/claude-desktop-sync.test.ts`: preserves concurrent metadata edits made during remote contact and rolls back correctly if an edit races inside the locked window.
- `tests/claude-desktop-protocol.test.ts`: doctor does not invent verified OS registration when XDG default is unknown.
- `tests/claude-desktop-cli.test.ts`: discovery-only profiles do not yield false drift warnings.

**Not proven:** adoption by an installed Desktop build, real MIME default registration, user session reload or authenticated vendor inference. There is no atomic two-file crash transaction guarantee.

## Reusable engineering lessons

1. **Release clocks**: compare event/merge time against tag/publication time. A PR merged after the tag is not part of that package. Track source, CI, artifact, client integration and deployed runtime as distinct states.
2. **Reviewbot reports are hypotheses**: inspect exact-head source, JS/TS async semantics and test fixtures before calling an alert a defect. Comparing a Promise object by identity to clear an in-flight slot is not intrinsically a missing `await`; changing it without proving a failing trace can introduce races.
3. **Identity isolation**: keep provider data-plane tokens, Codex Direct credentials and management authorization separate. Secret-safety must be asserted in tests, not inferred from 2xx checks.
4. **Concurrent config updates**: acquire shared lock before re-reading mutable local metadata; test both pre-lock and inside-lock races. Backups carrying credentials need bounded retention and verified private permissions.
5. **Proof without overclaiming**: simulated vendor merging is a contract fixture; an installed vendor CLI and end-to-end inference are separate acceptance gates. A green status or resolved bot thread is not standalone security approval.

Follow-through is tracked in [ROADMAP.md](../../ROADMAP.md). Public behavior and commands belong in [docs-site](../../docs-site/), stable invariants in [structure](../../structure/), and cross-repository operational lessons in the [ChefGroep operating playbook](https://github.com/GroepOnline/chefgroep-skills/blob/main/OPERATING-PLAYBOOK.md).
