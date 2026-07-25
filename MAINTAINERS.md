# Maintainers

This document lists the people responsible for maintaining the OnlineChefGroep fork of opencodex
and defines the project's review and merge policy.

**Upstream:** [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex)  
**Fork:** [OnlineChefGroep/opencodex](https://github.com/OnlineChefGroep/opencodex)

This fork is **fully independent** — it has its own versioning, release cycle, and CI pipeline.

## Current maintainers

| GitHub account | Project role | Responsibilities |
| --- | --- | --- |
| [@OnlineChef](https://github.com/OnlineChefGroep) | Fork owner | Project direction, releases, repository administration, and final governance decisions |

## Review and merge policy

- Pull requests target `main`.
- A pull request requires approval from at least one maintainer and successful required CI checks
  before merge.
- Authors do not approve their own pull requests.
- Authentication, credential handling, GitHub Actions, release automation, dependency installation,
  and other security-boundary changes require explicit security review.
- Direct pushes are reserved for maintainer-owned integration work, urgent repairs, or incident
  recovery. The same CI and documentation requirements still apply.

## Maintainer changes

Adding or removing a maintainer requires:

1. agreement from the fork owner,
2. review by another current maintainer when available, and
3. updates to this file and [`.github/CODEOWNERS`](./.github/CODEOWNERS).

## Security reports

Private vulnerability reports are handled by the current maintainers according to
[`SECURITY.md`](./SECURITY.md). Do not disclose secrets or exploit details in a public issue.
