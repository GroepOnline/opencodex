# VERSIONING.md

Versioning policy for the GroepOnline `opencodex` fork. The release contract lives in
`scripts/release.ts` and `.github/workflows/release.yml`; this file records the policy those
tools enforce.

## Version shape

Strict [SemVer 2.0.0](https://semver.org/) with one supported prerelease shape:

```text
MAJOR.MINOR.PATCH            stable     dist-tag: latest
MAJOR.MINOR.PATCH-preview.N  prerelease dist-tag: preview
```

- `X.Y.Z-preview.N` is the **only** accepted prerelease form. `-alpha`, `-beta`, `-rc`, and other
  suffixes are rejected before publication by `scripts/release.ts` (see `structure/09_x10-terminal-plan.md`).
- The `preview` channel is a monotonically increasing `-preview.N` train per `MAJOR.MINOR.PATCH`
  core; a later `vX.Y.Z-preview.*` is always older than its stable `vX.Y.Z`.
- Stable releases always bump `PATCH` (or higher) from the last published version — never reuse or
  regress a consumed version number.

## Dist-tags

| Dist-tag | Meaning | Shape |
| --- | --- | --- |
| `latest` | Stable, production installs | `X.Y.Z` |
| `preview` | Prerelease train, update-notifier channel | `X.Y.Z-preview.N` |

The update client recognizes the `preview` channel; a stable release must never be published under
`preview` and a prerelease must never be published under `latest`. `scripts/release.ts` refuses a
mismatch before doing any work.

## Who may release

Releases run from `main` only (`release.yml` rejects any other ref). The release helper requires a
clean working tree, `gh` CLI auth, and local gates green (typecheck, `bun test --isolate tests`,
`bun run privacy:scan`) before it bumps and dispatches.

## Source of truth

- Contract: `scripts/release.ts`, `.github/workflows/release.yml`
- Release metadata invariants: `structure/06_docs-and-release.md` → "Release metadata invariants"
- Full procedure: `RELEASE_PROCESS.md`
- Released history: `CHANGELOG.md`
