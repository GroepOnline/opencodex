# scripts/research

Offline autoresearch harness for OpenCodex. See `AGENTS.md` in this directory for the rules an optimizing agent must follow.

Status: scaffold. The measurement code, target configs, and tests land in follow-up commits on this draft PR.

Layout (target):

- `run.ts` - CLI entry: `baseline` and `run` subcommands, JSON on stdout.
- `lib.ts` - shared helpers: safe process spawning, timing statistics, atomic writes, git change guards, verdicts.
- `targets/*.json` - one config per target: metric, direction, command, mutable and frozen paths, guards.
- `measure/*.ts` - one measurement script per target; each prints a single JSON object.

Run state lives in `.tmp/research/`, which is already gitignored.
