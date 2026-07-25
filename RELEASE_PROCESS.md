# Release Process

## Quick start

```bash
# 1. Bump version in package.json
npm version patch  # or minor / major

# 2. Update CHANGELOG.md with the new version + notes

# 3. Create a release commit + tag
git commit -m "chore(release): v$(node -p 'require("./package.json").version')"
git tag -a "v$(node -p 'require("./package.json").version')" -m "v$(node -p 'require("./package.json").version')"

# 4. Push
git push origin main --follow-tags

# 5. Dispatch the Release workflow from GitHub Actions
#    → https://github.com/OnlineChefGroep/opencodex/actions/workflows/release.yml
#    Enter version, dist-tag (latest/preview), dry-run (set false to publish)
```

## Automated release

The [Release workflow](.github/workflows/release.yml) uses Trusted Publishing (OIDC) to authenticate
with npmjs.org — no tokens or secrets needed. It:

1. Verifies `package.json` version matches the workflow input.
2. Builds the GUI bundle.
3. Runs `npm publish` with provenance attestation.
4. Creates a GitHub Release with release notes.
5. Pushes the version tag back to the repository.

## Manual release (local)

```bash
npm run build:gui
npm pack                       # verify the tarball contents
npm publish --dry-run          # one last check
npm publish                    # actual publish
git tag -a v$(node -p 'require("./package.json").version') -m "v$(node -p 'require("./package.json").version')"
git push origin --tags
```

## Important notes

- Always run `bun test --isolate tests/` before releasing.
- Update `CHANGELOG.md` before the release commit.
- The `latest` dist-tag is for stable releases; use `preview` for beta/experimental builds.
- Never release from a working branch — always from `main`.
