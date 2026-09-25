# Contributing

Thanks for helping with opencodex.

- Start with the canonical guide: [Contributing](https://opencodex.me/contributing/)
- Public user docs live in [`docs-site/`](./docs-site)
- Current maintainer invariants live in [`structure/`](./structure)
- Maintainer roles and merge policy live in [`MAINTAINERS.md`](./MAINTAINERS.md)
- Historical investigations live in [`docs/`](./docs)

## Branches

- `main` — the only integration target for pull requests.
- `dev` — leftover line. Same-repository `dev` → `main` promotion remains an
  explicit exception in the target-branch check. Feature heads must target `main`.
- `preview` — prerelease train.

The `dev2-go` Go native-port line has been retired. Its history is archived at
[GroepOnline/opencodex-go-archive](https://github.com/GroepOnline/opencodex-go-archive),
and everything now goes to `main`. See [`MAINTAINERS.md`](./MAINTAINERS.md) for
the reasoning.

Rebase pull requests are welcome: bringing a stale branch onto the current head
is normal contribution. Note the source commits in the description.

Agent-facing repository and review rules live in [`AGENTS.md`](./AGENTS.md).

For local development commands, architecture notes, and release workflow details, use the hosted
contributing guide above instead of duplicating instructions here.

Source development requires the `bun` CLI on your `PATH`. The published npm package bundles its own
Bun runtime for end users, but contributor commands such as `bun install`, `bun run test`, and
`bun run prepush` run from your local Bun installation.

The production proxy path (Compose + systemd + `:10100/healthz`) has a complete local/dev
mirror: repo-root `compose.yml`, `.devcontainer/`, `.env.example`, and
`bash scripts/healthz-smoke.sh`. Authentik OIDC canary:
`bash scripts/oidc-authorize-canary.sh`. See
[`deploy/container/README.md`](./deploy/container/README.md) and
[`deploy/oidc/CUTOVER-CHECKLIST.md`](./deploy/oidc/CUTOVER-CHECKLIST.md).

## Git hooks

`bun install` runs Husky via the `prepare` script and installs committed hooks from
`.husky/` (pre-commit and pre-push). If hooks are missing after clone, run once:

```sh
bun run setup:hooks
```

**Pre-commit** runs `lint-staged` (Prettier on staged files). Skip in an emergency with
`git commit --no-verify`.

**Pre-push** dispatches the full `bun run prepush` gate — `typecheck`, `lint:gui`,
`test`, `privacy:scan`, and `doctor:gui:if-changed` — before every `git push`.
On a developer laptop it skips that heavyweight gate unless
`OCX_RUN_LOCAL_PREPUSH=1` is set, so the push can trigger verification on
GitHub-hosted CI or another authorized isolated build environment. CI builds the
GUI and smoke-tests the CLI as well. Do not use `git push --no-verify`; inspect the
exact-head CI result before merging.
