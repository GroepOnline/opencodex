# Contributing

Thanks for helping with opencodex.

- Start with the canonical guide: [Contributing](https://opencodex.me/contributing/)
- Public user docs live in [`docs-site/`](./docs-site)
- Current maintainer invariants live in [`structure/`](./structure)
- Maintainer roles and merge policy live in [`MAINTAINERS.md`](./MAINTAINERS.md)
- Historical investigations live in [`docs/`](./docs)

## Branches

- `dev` — the only integration target for pull requests.
- `main` — releases only; moves by maintainer-controlled promotion from `dev`.
- `preview` — prerelease train.

The `dev2-go` Go native-port line has been retired. Its history is archived at
[GroepOnline/opencodex-go-archive](https://github.com/GroepOnline/opencodex-go-archive),
and everything now goes to `dev`. See [`MAINTAINERS.md`](./MAINTAINERS.md) for
the reasoning.

Rebase pull requests are welcome: bringing a stale branch onto the current head
is normal contribution. Note the source commits in the description.

Agent-facing repository and review rules live in [`AGENTS.md`](./AGENTS.md).

For local development commands, architecture notes, and release workflow details, use the hosted
contributing guide above instead of duplicating instructions here.

Source development requires the `bun` CLI on your `PATH`. The published npm package bundles its own
Bun runtime for end users, but contributor commands such as `bun install`, `bun run test`, and
`bun run prepush` run from your local Bun installation.

## Git hooks

`bun install` runs Husky via the `prepare` script and installs committed hooks from
`.husky/` (pre-commit and pre-push). Linked worktrees and non-default `core.hooksPath`
setups are supported the same way. If hooks are missing after clone, run once:

```sh
bun run setup:hooks
```

**Pre-commit** runs `lint-staged` (Prettier on staged files), then `typecheck`, then
`test`. Skip in an emergency with `git commit --no-verify`.

**Pre-push** runs `bun run prepush` — `typecheck`, `lint:gui`, `test`, `privacy:scan`,
and `doctor:gui:if-changed` — before every `git push`. The same checks run on
ubuntu-latest, macos-latest, and windows-latest in CI (CI additionally builds the GUI
and smoke-tests the CLI). Skip in an emergency with `git push --no-verify`.
