# Research harness instructions

This file applies to `scripts/research/` and inherits `/AGENTS.md` and `/scripts/AGENTS.md`.

## Purpose

An offline, deterministic measurement harness so an external agent (droid, pi, or similar) can run autoresearch-style optimization loops against OpenCodex. The harness measures; the agent changes code. Nothing here runs in production, in release gates, or in the published package.

## Hard boundaries

- Branch from `main`, after the `v1.5.3` tag. Never touch release tooling: `scripts/release.ts`, `.github/workflows/`, the package version, dependencies, or lockfiles.
- No new runtime dependencies. The harness uses Bun and Node built-ins only.
- Only the `mutable` paths of the active target config may change. Harness code, fixtures, target configs, and tests are `frozen`.
- Payloads must stay semantically identical. Never rewrite user content in prompts.
- No secrets, request bodies, account identifiers, or personal paths in fixtures, logs, or output JSON. Usage logs must be anonymized before replay.
- Do not optimize `src/server/responses/compaction.ts` without a quality eval.
- Do not add microbenchmarks (mitata) for plugin dispatch, counters, or token buckets. They measure nanoseconds next to network latency.

## Loop protocol

1. `bun scripts/research/run.ts baseline --target <id>`
2. Make one focused change inside the target's `mutable` paths.
3. `bun scripts/research/run.ts run --target <id>`
4. Keep the change only when the verdict is `improved` and the exit code is 0. On `no-change`, `regressed`, or `guard-failed`, revert with git.
5. Before every commit run `bun run typecheck`, `bun run test`, and `bun run privacy:scan`. A change that turns any of them red is reverted, whatever the metric says.

## Targets

| Id | Metric | Direction | Status |
| --- | --- | --- | --- |
| `cold-start` | ms until `/healthz` answers, tarball bytes, RSS | lower | first target, proves the harness |
| `prompt-cache` | `cacheReadRatio` on an anonymized usage replay | higher | needs a local anonymized `usage.jsonl` |
| `ci-shard` | longest shard seconds, flake rate | lower | needs timings from CI run history |
| `routing` | success rate, p95 TTFT, cost | mixed | blocked until the trace store returns |
