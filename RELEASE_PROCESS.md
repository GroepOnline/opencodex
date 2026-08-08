# RELEASE_PROCESS.md

How to ship a new version of `@groeponline/opencodex` to npm. Follow this end-to-end; the release
helper automates the whole path but every step below is also executable by hand.

## Prerequisites

- Working tree clean, on `main`.
- `gh` CLI installed and authenticated.
- No earlier version with the same number on npm, on the `v<version>` Git tag, or on GitHub
  Releases — the helper refuses to proceed if any of the three already exists.

## Quick start (recommended)

```bash
bun scripts/release.ts 1.0.1                 # bump + push + CI wait + dry-run publish
bun scripts/release.ts 1.0.1 --publish       # actually publish
bun scripts/release.ts watch                 # watch the most recent Release run
```

What the helper does:

1. **Preflight** — clean tree, on `main`, version shape and dist-tag valid, npm/tag/Release
   unused, then local gates: `bun x tsc --noEmit`, `bun test --isolate tests`,
   `bun run privacy:scan`.
2. **Bump** — `npm version <version> --no-git-tag-version`, commit `release: v<version>`, push.
3. **CI wait** — waits for Cross-platform CI **and** Service lifecycle on the release SHA.
4. **Dispatch** — re-verifies the live remote head still equals the release commit (the
   `expected-sha` guard), then dispatches `release.yml` with `dry-run=true` (default) or
   `dry-run=false` with `--publish`.
5. **Watch** — streams the Release workflow run to completion.

A dry run builds + packs the tarball but does **not** publish. Re-run with `--publish` for real.

## Manual dispatch (without the helper)

1. Bump `version` in `package.json` on `main` and push. The release workflow only publishes the
   exact `GITHUB_SHA` it runs on.
2. Wait for Cross-platform CI to pass on that commit (`Actions → CI`).
3. Dispatch `Actions → Release` with inputs:
   - `version`: must equal `package.json` version
   - `tag`: `latest` for stable, `preview` for prerelease
   - `dry-run`: `true` first, then `false` for the real publish
   - `expected-sha`: the release commit SHA (fail-fast if the branch moved)

## Version selection

- Stable fixes/features: bump `PATCH` (or `MINOR`/`MAJOR` for intentional breaking changes).
- Preview trains: `X.Y.Z-preview.N` on the `preview` dist-tag. Matching preview notes are
  aggregated into the stable changelog (see `scripts/release-notes.ts`).
- Never reuse a version that already exists on npm, as a Git tag, or as a GitHub Release. If
  release metadata is inconsistent, treat the version as consumed and ship the next unused patch
  (see `structure/06_docs-and-release.md`).

## What publishing does

The Release workflow (manual dispatch, `concurrency: release`):

- Verifies `GITHUB_SHA` equals `expected-sha` (when supplied).
- Publishes to npm via **Trusted Publishing (OIDC)** — no `NPM_TOKEN` secret.
- Creates the `v<version>` Git tag and GitHub Release from the exact release commit, with a
  changelog body derived from `scripts/release-notes.ts` (PR/commit history since the prior
  release, including carried preview deltas).

`prepublishOnly` runs typecheck + `build:gui` (bundled `gui/dist`) before the pack.

## Post-release

- Verify: `npm view @groeponline/opencodex@<version> version`
- Install smoke: `npm install -g @groeponline/opencodex@<tag>` and `ocx help`.
- Update `CHANGELOG.md` with the released entry (the GitHub Release body is generated; the
  changelog file is the durable record).
- Docs deploys are independent of npm release (`deploy-docs.yml` on `main` docs pushes).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `must be on main` | The helper only releases from `main`. |
| `working tree not clean` | Commit or stash uncommitted changes first. |
| `Release tag mismatch` | Stable must use `latest`, prerelease `preview`; the helper validates the shape. |
| `version is already partially or fully used` | Pick the next unused patch version. |
| `origin/main moved while waiting` | The remote head changed during CI wait; re-run from the new head. |
| `error: branch moved` (workflow) | The dispatched branch no longer matches `expected-sha`; re-dispatch from the audited commit. |
