# Research harness instructions

This file applies to `scripts/research/` and inherits `/AGENTS.md` and `/scripts/AGENTS.md`.

## Purpose

An offline, deterministic measurement harness so an external agent (droid, pi, or similar) can run autoresearch-style optimization loops against OpenCodex. The harness measures; the agent changes code. Nothing here runs in production, in release gates, or in the published package.

## Hard boundaries

- Branch from `main`, after the `v1.5.3` tag. Never touch release tooling: `scripts/release.ts`, `.github/`, the package version, dependencies, or lockfiles.
- No new runtime dependencies. The harness uses Bun and Node built-ins only.
- Only the `mutable` paths of the active target config may change. The harness itself (`scripts/research/`, `tests/research-harness.test.ts`), fixtures, and target configs are frozen. `run` enforces this against the baseline commit.
- Fixtures live in `.tmp/research/fixtures/` and are held out. Mutable code must never read them or reference `.tmp/research` or `scripts/research`; `run` scans changed files for those strings.
- Payloads must stay semantically identical. Never rewrite user content in prompts.
- No secrets, request bodies, account identifiers, or personal paths in fixtures, logs, or output JSON. Usage logs must be anonymized before analysis.
- Do not optimize `src/server/responses/compaction.ts` without a quality eval.
- Do not add microbenchmarks (mitata) for plugin dispatch, counters, or token buckets. They measure nanoseconds next to network latency.

## Loop protocol

1. Commit or stash everything, then `bun scripts/research/run.ts baseline --target <id>`. A dirty tree is refused.
2. Make one focused change inside the target's `mutable` paths.
3. Optional quick look while iterating: `bun scripts/research/run.ts measure --target <id>`. It has no verdict and no guards, so it never justifies keeping a change.
4. `bun scripts/research/run.ts run --target <id>`. This checks boundaries and fixtures, runs the guards (`typecheck`, `test`, `privacy:scan`), measures, and prints one JSON verdict.
5. Keep the change only on verdict `improved` (exit 0). On `no-change` (2), `regressed` (3), or `guard-failed` (4), revert with git. Exit 1 is a harness error, not a result.

A change counts as `improved` only when it beats the larger of the target's `minImprovementPct` and the observed run-to-run spread of both the baseline and the current runs.

## Targets

| Id | Metric | Direction | Status |
| --- | --- | --- | --- |
| `cold-start` | `startupMs` until `/healthz` answers; RSS and tarball bytes as details | lower | ready, first target to prove the harness |
| `ci-shard` | simulated longest CI shard in seconds | lower | ready once a maintainer builds the local timings fixture |
| `prompt-cache` | `cacheReadRatio` from the analyzer on a local usage log | higher | analysis-only: a recorded log cannot score a request-builder change |
| `routing` | success rate, p95 TTFT, cost | mixed | blocked until the trace store returns |

`baseline` and `run` refuse targets that are not `ready`.
