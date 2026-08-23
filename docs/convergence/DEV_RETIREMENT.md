# `origin/dev` retirement

`origin/dev` @ `07bc1f60` is **5 ahead, 0 behind** `origin/main` @ `4a589932`.
Every one of those five commits must be decided before the branch is deleted.
This sequence is reversible at every step: no force-push, no tag moves, no
production change.

## The five commits (oldest first)

| # | SHA | Subject | Must land on main? | How |
| --- | --- | --- | --- | --- |
| 1 | `c06ae3a0` | feat: Availability module, key-pool failover, KV response cache, ops GUI (Fase A–D) (#76) | **Yes.** Production-relevant routing/failover/cache/ops GUI. Not on main. | Open a promotion PR `dev` → `main` (preferred) or cherry-pick this SHA onto `main`. Do not squash again; #76 is already a squash of the r2 history. |
| 2 | `3722e7b9` | fix(routing): standardize availability pool, cache, and latency behavior (#86) | **Yes.** Review fixes for #76 (OAuth pool caps, anonymous cache, latency windows). Tree-identical to `origin/fix/availability-standard`. | Same promotion PR; or cherry-pick after #1. |
| 3 | `f29a58b2` | fix(ci): deploy OpenCodex on chef-control-az-01 (#85) | **Yes.** Retargets deploy from retired `chef-control-01` to `chef-control-az-01`, Tailscale health discovery, fail-closed without Tailscale. Snapshot V2/V5. Tree-identical CI files to `origin/fix/az-01-deploy-runner`. | Same promotion PR; or cherry-pick after #2. Does **not** by itself fix V1 (deploy path vs runtime path) or V6 (host Node). |
| 4 | `c5a2d15d` | fix(availability): hop 402 OAuth pools and restrict Access inject (#87) | **Yes.** 402 pool hop + scoped Cloudflare Access inject. Content-identical to `origin/fix/oauth-402-hop-and-access-inject` aside from #85 deploy files. | Same promotion PR; or cherry-pick after #3. |
| 5 | `07bc1f60` | docs(gui): v2 Devin-richting → v3 Signaal (#89) | **Yes, but docs-only.** Header-comment rename in `gui/DESIGN.md` + `gui/src/styles.css`. Tree-identical to `origin/docs/signaal-v3-consumer-naming`. | Same promotion PR; or cherry-pick last. Safe to land with #1–#4; no runtime effect. |

Cherry-pick vs PR: prefer **one promotion PR** whose head is `origin/dev` (or `origin/dev` + #90) targeting `main`. That preserves the already-reviewed squash boundaries. Cherry-pick the five SHAs onto `main` only if the promotion PR cannot be opened (for example after the target-gate flip rejects `dev` as a base — then open the promotion from a topic branch that contains exactly these five commits).

## Open PRs that currently target `dev`

They must not be lost.

### PR #88 — `fix/signaal-drift-cleanup`

- Head `d8e81893` is **based on `origin/main`**, not on the five-commit stack.
- Unique commits: `7b0a9d64`, `d55af0e7`, `d8e81893`.
- Action: **retarget the existing PR to `main`**. No rebase required against the five commits (merge-base is already `4a589932`). Do this after the target-gate flip, or immediately before if the gate still accepts `dev`.
- If GitHub refuses a retarget, open a new PR with the same three commits against `main` and close #88 as superseded by the new number.

### PR #90 — `fix/azure-gui-deploy-lane`

- Head `158cc061` is **`origin/dev` + 1 commit** (`fix(ci): require deployable OCX GUI`).
- Unique-on-top-of-dev: `158cc061` (deploy.yml GUI build gate + 4 test lines).
- Action options, in order:
  1. **Preferred:** include `158cc061` in the promotion PR (fast-forward `origin/dev` to `158cc061`, or make the promotion head this SHA). Then close #90 as merged-via-promotion.
  2. After the five commits are on `main`, rebase `158cc061` onto `main` and **retarget #90 to `main`**.
  3. If #90 would be closed by GitHub when `dev` is deleted, cherry-pick `158cc061` onto `main` first.

Do not delete `origin/dev` while #88 or #90 still lists `dev` as base.

## Ordered, reversible sequence

Do not run the archive `git tag` commands in this file during the freeze.
Do not push, merge, or retarget from this worktree.

1. **Record** — this document + `BRANCH_DISPOSITION.md` on `convergence/lane-a-git`. Already the analysis of record.
2. **Flip the target gate to main-only** (this lane's code change). After it lands on the GitHub default branch, new PRs cannot target `dev`. In-flight #88/#90 keep their current base until someone retargets them; CI `pull_request` still lists `dev` so they do not go dark. Revert commit: the gate flip commit on this branch.
3. **Promote the five commits** — open PR `promotion/dev-to-main` (or retarget a maintainer PR) whose head is `07bc1f60` or `158cc061`, base `main`. Review as the already-landed #76/#86/#85/#87/#89 plus optional #90. Merge with the existing squash SHAs (do not re-squash). Revert: revert the merge commit on `main`.
4. **Retarget #88 to `main`.** Confirm the three Signaal-drift commits are still the only unique commits. Revert: retarget back to `dev` while `dev` still exists.
5. **Resolve #90** via step 3 option 1 or 2. Confirm `158cc061` is reachable from `origin/main`.
6. **Retarget or close every other open PR that still lists `dev`** (`gh pr list --base dev`). Wave 0 only recorded #88 and #90; re-check at execution time.
7. **Flip Dependabot** `target-branch` to `main` (already in this lane). Confirm no Dependabot PR is still queued against `dev`.
8. **Archive tags** (commands below — do not execute here). Push tags only when a later un-frozen lane is authorized to mutate the remote.
9. **Delete `origin/dev`** (`git push origin --delete dev`) only after: tags exist, #88/#90 no longer target `dev`, promotion merge is on `origin/main`, and `git merge-base --is-ancestor 07bc1f60 origin/main` is true. Revert: `git push origin archive/dev-07bc1f60:refs/heads/dev`.
10. **Drop `dev` from CI `pull_request` / `push` branch lists** (`ci.yml`, `service-lifecycle.yml`). Listed as ambiguous during the flip; do it here, not earlier. Revert: restore the `dev` entries.

## Archive policy (do not execute)

Tag every EXPERIMENT / SUPERSEDED / DEAD head so deletion loses nothing.
`origin/dev` and KEEP/PARTIAL heads are tagged too so retirement is reversible.
Lightweight tags, exact SHAs, names stable under `archive/`.

```sh
# Run from a clone that can see origin/*. Do not run during the freeze.

git tag archive/dev-07bc1f60                         07bc1f60476060ebb9e416ef2dc0e68e87497d84
git tag archive/ci-auto-deploy-and-hygiene           834f747fe3ab18e76dcfeaedba8df743032313b8
git tag archive/docs-signaal-v3-consumer-naming      c981dd9f5c1636d1b7def7ed5465abe46523eea0
git tag archive/fix-availability-standard            de51ab137b1dd8081b65579aa9f730d76bb456fc
git tag archive/fix-az-01-deploy-runner              8ac0c73da1e37aecdeb0b7d8c02285faeb0306fd
git tag archive/fix-ci-hygiene-audit                 5624c012cda71cfce231ed72f2141f4f260e970f
git tag archive/fix-live-claude-desktop-laptop-sync  b8a86b63f80dc1f2f54c5357c4614b346cdbff6c
git tag archive/fix-oauth-402-hop-and-access-inject  bbb015c6ba5ffc19c0d2484726922104467f7aac
git tag archive/r2-avail-unused-imports              66b8daa2602738059816d99a10992e88a52d75ee
git tag archive/r2-css-provider-shell                20705b092a50d11c454f6b53a6e581b9f2ce7ea8
git tag archive/r2-css-settings-catalog              11c387059040c66a72b22a2d3d4c2616f766b93b
git tag archive/wip-usage-account-label              d7bd55d99f55b26e6881676f3ca63b39a1e2d156

# KEEP / PARTIAL — tag before anyone deletes the branch even if the work is still in flight
git tag archive/feat-provider-fetch-models           5296ac92812ce30012c70535b010fd3efcebb5fa
git tag archive/fix-cloudflare-workers-ai-livemodels 02c8f212c07a57b3d40da6c74e582bdaf7bfa768
git tag archive/fix-gui-dashboard-live-bugs          1169f3397120c3e48390eb84a4f810681bd481bb
git tag archive/fix-gui-dashboard-live-bugs-v2       5d89c2de7959460b123ae409642e562292b700ba
git tag archive/fix-signaal-drift-cleanup            d8e818936adaa7a635bd3a0b3b559a71ca87e99c
git tag archive/fix-azure-gui-deploy-lane            158cc061dc26d9fc2de8784a164fe1b6f6c73f68

# After tags exist and the promotion + PR retargets are done:
# git push origin --delete dev
# git push origin --delete ci/auto-deploy-and-hygiene
# git push origin --delete docs/signaal-v3-consumer-naming
# git push origin --delete fix/availability-standard
# git push origin --delete fix/az-01-deploy-runner
# git push origin --delete fix/ci-hygiene-audit
# git push origin --delete fix/live-claude-desktop-laptop-sync
# git push origin --delete fix/oauth-402-hop-and-access-inject
# git push origin --delete r2-avail-unused-imports
# git push origin --delete r2-css-provider-shell
# git push origin --delete r2-css-settings-catalog
# git push origin --delete wip/usage-account-label
```

Do **not** tag or delete `origin/main`. Do **not** create `archive/` tags from
the dead workstation `main` @ `baadc835`.

## Listed, not changed (ambiguous or historical)

These still mention `dev` as an integration line. They were **not** silently
rewritten:

| Path | Why left |
| --- | --- |
| `.github/workflows/ci.yml` `pull_request.branches: [main, dev]` and `push.branches: [main, preview, dev]` | In-flight PRs #88/#90 still target `dev` and must keep CI. Drop `dev` in retirement step 10. |
| `.github/workflows/service-lifecycle.yml` `branches: [main, dev]` | Same transitional CI coverage. |
| `.github/workflows/{pr-labeler,enforce-issue-quality,stale-needs-info}.yml` header comments | Operational note that `pull_request_target` loads from the default branch (`main`), not from `dev`. Still true; not a PR-target rule. |
| `structure/09_x10-terminal-plan.md` | Historical 2026-08-02 plan ("PRs target `dev`"). |
| `structure/plugin-metrics-ratelimit-benchmarks.md` | Historical implementation plan targeting `dev`. |
| `structure/06_docs-and-release.md` | Describes current CI triggers including `dev`; keep in lockstep with `ci.yml` until step 10. |
| `docs/superpowers/plans/2026-07-26-oauth-reliability-integrity.md` | Historical plan ("PRs target `dev`"). |
| `docs/superpowers/plans/2026-07-28-pr-quality-gates.md` | Historical #644 design (`dev`/`dev2-go` ancestry). |
| `docs/superpowers/specs/2026-07-28-pr-quality-gates-design.md` | Same, as a spec snapshot. |
| `ROADMAP.md` | Completed-item history ("`dev` integration", reconcile). |
| `CHANGELOG.md` | Released-history wording. |
| `MAINTAINERS.md` change-log entry 2026-07-27 | Historical record of landing on `dev`. |
| `RELEASE_PROCESS.md`, `VERSIONING.md` | Already main-only for releases; no `dev`-as-integration statement. |
