# scripts/research

Offline autoresearch harness for OpenCodex. `AGENTS.md` in this directory holds the rules an optimizing agent must follow; this file explains how the pieces fit.

## Layout

- `run.ts` - CLI: `list`, `measure`, `baseline`, `run`. One JSON object on stdout, progress on stderr.
- `lib.ts` - shared helpers: process spawning without a shell, timing statistics, verdicts, atomic JSON writes, git change guards, fixture hashing, shard partition checks.
- `targets/*.json` - one config per target: metric, measurement command, run count, mutable paths, fixtures, guards.
- `measure/*.ts` - one measurement script per target. Each prints a single JSON object `{ "value": number, "details": {...} }` as its last stdout line.

Run state is written to `.tmp/research/`, which is already gitignored.

## Exit codes of `run`

| Code | Meaning |
| --- | --- |
| 0 | `improved` (also the code for `list`, `measure`, `baseline`) |
| 1 | harness error |
| 2 | `no-change` |
| 3 | `regressed` |
| 4 | `guard-failed` (boundary, forbidden reference, fixture change, or a failing guard command) |

## Targets in practice

`cold-start` spawns `start --proxy-only` on an isolated HOME and a free port, polls `/healthz`, and reports the elapsed milliseconds. A server that exits non-zero before answering fails the measurement. RSS is read from `/proc` on Linux, from `ps` on macOS, and is `null` on Windows. Tarball bytes come from `npm pack --dry-run --ignore-scripts` and are `null` when npm is unavailable.

`ci-shard` runs the real `assignBalancedShards` on the real test list and scores the result against held-out per-file timings. A maintainer builds the fixture once on a quiet machine:

```bash
bun scripts/research/measure/ci-shard.ts --collect
```

That times every test file sequentially into `.tmp/research/fixtures/ci-timings.json` (use `--limit N` for a quick trial). The assignment function never sees the timings; to use runtime-based balancing it must read a committed estimates file derived from CI run history.

`prompt-cache` wraps `scripts/analyze-prompt-cache-usage.ts` over `.tmp/research/fixtures/usage.jsonl` and reports the aggregate ratio and the five weakest cohorts. It is analysis-only; see `AGENTS.md`.
