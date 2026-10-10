# Repository Review and Action Plan (2026-10-10)

**Scope:** full pass over `GroepOnline/opencodex` at `main` (`7292e96`, package version 1.5.4), including a
claim-by-claim verification of [`docs/architecture-review-2026-10-10.md`](../../architecture-review-2026-10-10.md)
against the actual code.

**Method:** repository tree and branch/PR/CI state read through the GitHub API; the working tree was cloned and
the baseline gates were run locally before any change was proposed. Findings below are limited to what was
observed; anything not checked is marked as such.

## 1. Baseline

| Check                                                              | Result                                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc --noEmit` (strict)                                            | exit 0 on `main` (needs a larger Node heap than the default on a 1 GB machine)                                                                                   |
| `bun run privacy:scan`                                             | passed                                                                                                                                                           |
| `bun test tests/proxy-liveness.test.ts tests/oauth-health.test.ts` | 36 pass, 0 fail                                                                                                                                                  |
| `bun run test` (full suite)                                        | not completed locally: the 1 GB sandbox OOM-killed it (exit 137) after 103 test files; 1,336 tests passed, 0 failed before that. The complete run is left to CI. |
| CI on `main` (`7292e96`)                                           | Push on main, Code Quality and React Doctor succeeded                                                                                                            |
| Workflow action refs                                               | every `uses:` line in `.github/workflows` is pinned to a 40-character SHA                                                                                        |
| Hygiene (`src/`, excluding generated)                              | 2 `TODO/FIXME`, 1 `as any`, 0 `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`                                                                                  |

Size: 459 files in `src/`, 545 in `tests/`, 466 in `gui/`. Seven non-generated source files exceed 1,500 lines:
`src/server/responses/core.ts` (3,257), `src/storage/cleanup.ts` (3,014), `src/service.ts` (2,701),
`src/providers/registry.ts` (2,376), `src/config.ts` (2,033), `src/server/index.ts` (1,864) and
`src/adapters/kiro.ts` (1,654).

Open work at the time of the review: PR #340 (Claude Desktop hardening), draft PR #334 (offline autoresearch
harness), issues #336 (P0: OCX-only first) and #272 (opt-in Redis shared runtime, deferred). The `Enforce issue quality` workflow failed in [run 38003010549](https://github.com/GroepOnline/opencodex/actions/runs/38003010549) on `jan-opencodex`: `actions/checkout` hit an HTTP/2 framing error while resolving promised Git objects (exit 128); validation never ran. The CI repair belongs in a separate code PR.

Branches other than `main` (ahead / behind `main`): `cursor/retarget-ubuntu-self-hosted-7db4` (9 / 93),
`feat/providers-account-cli-20261003` (23 / 44), `feat/posthog-settings-toggle-v2` (1 / 43),
`pre-release/v1.5.3-verified-20261008` (8 / 8), `feat/autoresearch-harness-20261009` (2 / 7, PR #334) and
`fix/desktop-integration-review-20261010` (1 / 1, PR #340).

## 2. Verification of the architecture review

The review is a useful map of where friction might be, but several of its concrete recommendations do not hold
up against the code, and two of them would weaken safety properties. Because `docs/` is read by agents as well as
humans, the wrong recommendations are corrected here rather than left to be executed.

| Review claim                                                                  | Verified result                                                                                                                                                                                                                                                                                                                                                                                                                                 | Decision               |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Merge `findLiveProxy` and `findReachableProxyForCli` into `findProxy(mode)`   | The two are not duplicates. `findLiveProxy` may return a locally verified, killable PID; its configured-endpoint discovery is pidless. `findReachableProxyForCli` first returns any `findLiveProxy` result, and only its configured-endpoint retry fallback always returns `pid: null`. `oauth/health.ts` sends the admin bearer only for a verified local PID **and** loopback target; `ocx stop` retains its strict ownership check.          | **Do not merge**       |
| Simplify `cursor/exec-policy.ts` to one export ("trivial ternary")            | The file is the fail-closed authorization gate for Cursor server-driven local execution (`resolveCursorNativeExecMode`, `effectiveCursorNativeExecAllow`, the denied-case list). Its many small exports and long comments are deliberate.                                                                                                                                                                                                       | **Do not simplify**    |
| Inline `gui/src/design-tokens.ts` (Option A)                                  | The module exports the `OperationalStatus` type used by four GUI files plus the badge-class map. Inlining would duplicate both.                                                                                                                                                                                                                                                                                                                 | **Keep as is**         |
| `provider-routes.ts` (678 lines) is a monolith; split into route groups       | `src/server/management/` is already split into 11 route-group modules. The real outlier is `agent-settings-routes.ts` (1,422 lines). The review's file sizes are correct, its conclusion is partly outdated.                                                                                                                                                                                                                                    | Re-scope (see 3.2)     |
| `runtime-api.ts` is a "utility kitchen sink" that should become three modules | It is one cohesive CLI management client (11 importers). It also contains credential-handling code: `SECRET_OPTIONS`, `redactSecretArgs` (keeps credentials out of usage errors) and `readSecretLine` (keeps them out of argv). Moving it is a security-boundary change per `AGENTS.md`.                                                                                                                                                        | Defer (see 3.3)        |
| `oauth/health.ts` mixes CLI display into runtime projection                   | The label/summary/action text is also consumed by the management API and `codex/auth-api.ts`, not only the CLI; the same file holds the admin-token fetch to the live proxy, where the bearer is only attached for a verified, loopback, pid-owning proxy. A split is possible but sits in the OAuth security boundary.                                                                                                                         | Defer (see 3.3)        |
| Cursor adapter has 32 files, tool logic spread over 6+ files                  | 30 `.ts` files plus `gen/` and 33 Cursor test files. The spread is real, but consolidation touches the same native-exec authorization surface as above and needs a design first.                                                                                                                                                                                                                                                                | Design first (see 3.4) |

## 3. Plan

### 3.1 Executed in this pull request (documentation only, no runtime change)

1. Record this review and plan (this file).
2. Add a verification note at the top of `docs/architecture-review-2026-10-10.md` pointing here, so the
   corrected recommendations travel with the original.
3. Fix `AGENTS.md`: it lists a `go/` directory that does not exist in the repository, and nothing under `src/`,
   `scripts/` or `.github/` references it.

Verification: `bun x prettier --check` on the changed files, `bun test tests/review-execution-policy.test.ts`
(reads `AGENTS.md`), `bun run privacy:scan`.

### 3.2 Recommended next (needs a maintainer to pick up)

- **Split `src/server/management/agent-settings-routes.ts` (1,422 lines) by settings area**, following the
  existing route-group modules. Management API changes are security-boundary changes, so the PR needs the
  explicit security analysis required by `MAINTAINERS.md`, plus the focused tests that already cover the routes.
- **Triage the very large modules** (`core.ts`, `cleanup.ts`, `service.ts`, `registry.ts`, `config.ts`,
  `server/index.ts`, `kiro.ts`): pick the one that changes most often (`git log --stat` per file) and carve out
  one cohesive responsibility behind its current exports. `src/AGENTS.md` asks not to add responsibilities to
  large shared modules, so the first target should be the one where new work keeps landing.

### 3.3 Deferred, with the condition that unblocks each

- **`runtime-api.ts` split.** Do it only as a verbatim move with re-exports from `runtime-api.ts` (11 importers
  keep working), moving the credential-redaction and secret-reading code unchanged, with the security analysis
  attached to the PR. The benefit is modest; skip it unless the file keeps growing.
- **`oauth/health.ts` split.** The pure label/summary/action functions can move to their own module with
  re-exports. The admin-token fetch stays where it is. Needs the same security analysis.

### 3.4 Design first

- **Cursor adapter consolidation.** Write down the invariants that must survive (fail-closed native exec, the
  denied-case list, the legacy mock path being non-executing) and map each of the 33 test files to the behavior it
  protects. Only then decide which of the tool-definition / request-builder / protobuf / arg-codec modules to
  merge.

### 3.5 Housekeeping for the maintainers (not done: needs a decision, and deletions are irreversible)

- Decide the fate of the stale branches listed in section 1, in particular
  `cursor/retarget-ubuntu-self-hosted-7db4` (93 commits behind) and `feat/posthog-settings-toggle-v2`
  (43 behind).
- Repair `jan` checkout HTTP/2 failures in issue-quality and dedup workflows, then verify a new issue event end-to-end.
- `AGENTS.md` says issues live in Linear while two GitHub issues (#336, #272) are open; decide whether they
  should be mirrored or closed.
