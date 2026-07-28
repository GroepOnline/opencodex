# Versioning Policy

**Package:** `@bitkyc08/opencodex`  
**Repository:** `OnlineChefGroep/opencodex`  
**License:** MIT

This fork of [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) follows **independent
semantic versioning** — we are **fully detached** from upstream releases.

Starting with the first fork release, our versioning is:

```
v<major>.<minor>.<patch>
```

## Rules

| Change | Rule |
|---|---|
| **Breaking change** (incompatible API, config, or CLI) | Bump **major** |
| **New feature** (backward-compatible) | Bump **minor** |
| **Bug fix** (backward-compatible) | Bump **patch** |

## Current version

Current: **`2.7.33`** (inherited from upstream; transition starts here)

Next release: **`1.0.0`** — our first independent release, signifying the fork's new identity.

## Version transition

Because this fork initially tracked upstream releases, the existing tags (`v2.7.26` … `v2.7.39`)
are kept for history. All **new** releases use our own scheme starting at `v1.0.0`.

## Release process

1. Update `CHANGELOG.md` with the new version and notes.
2. Bump version in `package.json`.
3. Commit and tag: `git tag -a v<version> -m "v<version>"`
4. Push tag: `git push origin v<version>`
5. The [Release workflow](.github/workflows/release.yml) handles npm publish + GitHub Release.

See [RELEASE_PROCESS.md](./RELEASE_PROCESS.md) for the full step-by-step guide.
