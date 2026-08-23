# Lane pass-1 verdict (Lane F follow-up)

**Authority:** Lane F (evidence only). No product code. No push. Production read-only.
**Verifier:** `/home/jan/ocx-convergence/lane-f-verify` (`convergence/lane-f-verify`)
**Window:** 2026-08-23 14:49–15:10 UTC+2
**Pins checked:** tips in `evidence/PROGRAM_STATUS.md` vs `git rev-parse --short HEAD` in each worktree. All eight match.

Verdict vocabulary:

| Verdict | Meaning |
|---|---|
| ACCEPT | Charter met; re-run evidence matches the lane's claims |
| ACCEPT-WITH-CAVEAT | Charter met, but a documented claim or merge instruction is wrong or will collide |
| REJECT | Charter missed, or a stop-the-line check failed |

---

## One-line verdicts

| Lane | Tip | Verdict |
|---|---|---|
| A Git | `4a74ce78` | **ACCEPT-WITH-CAVEAT** — main-only gate + meaningful ancestry; retirement text still lands `#85` |
| B Runtime | `917c0d0d` | **ACCEPT** — engine audit + 5/5 characterization tests |
| C State | `c68078d0` | **ACCEPT** — forensics + reconcile defaults to dry-run (10/10) |
| D Product | `a8d9aeb8` | **ACCEPT-WITH-CAVEAT** — no fake Overview metrics in product code; `#88` merge advice is wrong |
| E Delivery | `a4440b97` | **ACCEPT** — dirty refuse + SHA pin still present; 5/5 az-01 tests |
| F Verify | `a508cb71` | **ACCEPT** — Wave 0 re-derivation stands; this file is the pass-1 overlay |
| G Contracts | `a068bf01` | **ACCEPT-WITH-CAVEAT** — `/api/provenance` leaks no secrets; OAuth health heuristic is wrong on live |
| H Control | `bbeb4ff9` | **ACCEPT-WITH-CAVEAT** — true for `origin/main` today; stale the moment PR2 lands |

`origin/main` = `4a589932da38f65cffeac0e8b364322fd026c094`.
`origin/dev` = `07bc1f60476060ebb9e416ef2dc0e68e87497d84` (`0 5` vs main).

---

## Special checks (re-run)

### Lane E — dirty checkout + SHA pin

**Verdict: present and tested.**

Re-read `/home/jan/ocx-convergence/lane-e-delivery/.github/workflows/deploy.yml`:

- Step `Refuse dirty live checkout or dropped commits` (lines 108–121): `git status --porcelain` non-empty → exit 1; `git merge-base --is-ancestor HEAD "$tag_sha"` fails → exit 1.
- Step `Deploy into service checkout (in-place, pinned SHA)` (lines 155–168): `git checkout --force` + `git reset --hard` of `${{ steps.verify.outputs.tag_sha }}`; then `deployed_sha != tag_sha` → exit 1.
- `tag_sha` is pinned once in `Verify tag is on origin/main` via `git rev-parse "refs/tags/$tag"` after `merge-base --is-ancestor` vs `origin/main`.
- `DEPLOY_PATH: /opt/chef/services/opencodex`. Node pin `22.12.0`. `chef-control-01` remains only as a historical comment (line 15).

Re-run:

```text
cd /home/jan/ocx-convergence/lane-e-delivery
bun test tests/ci-workflows.test.ts -t 'az-01 deploy'
→ 5 pass, 73 filtered, 0 fail, 85 expects
```

Those five tests cover dirty-tree refuse, tag-shape fail-closed, SHA pin (never re-resolve `$tag`), L1–L4 step IDs, Node 22.12.0, and `DEPLOY_PATH`.

`origin/main` already had dirty refuse + SHA pin, pointed at `/home/chef/opencodex-psp`. `#85` on `origin/dev` kept those guards and moved `DEPLOY_PATH`. Lane E is a superset (config hostname, Node 22.12, L1–L4, SHA mismatch check), not a deletion of the guards.

### Lane A — ancestry is meaningful (not just deleted)

**Verdict: replaced, not deleted.**

`origin/main` `isWrongAncestry`:

```js
behindMain === 0 && behindBase >= 20 && aheadMain <= 5
```

That only flagged a head sitting on the main tip while behind `dev`. A stale feature branch that was also ahead of main passed.

Lane A (`pr-quality.cjs` lines 10–34):

```js
const ANCESTRY_BEHIND_THRESHOLD = 20;
function isWrongAncestry({ behindBase, threshold = ANCESTRY_BEHIND_THRESHOLD }) {
  return behindBase >= threshold;
}
```

`ALLOWED_BASES` flipped `["dev"]` → `["main"]` in both `enforce-pr-target.yml:49` and `tests/ci-workflows.test.ts:744`. Workflow comment now says “more than 20 commits behind the PR base.”

Re-run:

```text
cd /home/jan/ocx-convergence/lane-a-git
node --test .github/scripts/pr-quality.test.cjs
→ 21 pass, 0 fail
```

Named cases that prove the new rule: “uses threshold 20 by default” (20 fails, 19 passes); “flags a stale feature branch even when it is also ahead of main”; “flags a stale head even when it is also far ahead of main.”

### Lane G — `/api/provenance` leaks no secrets

**Verdict: no secrets in the public or authenticated builders.**

`src/server/build-provenance.ts` public body: `contract_version`, `version`, `git_sha`, `built_at`, `release`, `schema_version`, `gui_version`, `runtime.{service,pid,port,uptime,platform,bunVersion}`.
Authenticated add-on: `management.{hostname, default_provider, provider_count, management_auth_available}`.
`rg` of `build-provenance.ts` + `provenance-routes.ts` for `apiKey|refresh|access|token|secret|email|accountId`: **no matches**.

`src/server/index.ts:478–487`: unauthenticated `GET /api/provenance` is allowed; `/api/health` is behind `requireManagementAuth`.

Re-run:

```text
cd /home/jan/ocx-convergence/lane-g-contracts
bun test tests/management-contract.test.ts
→ 17 pass, 9 skip, 0 fail, 39 expects
```

Unauthenticated `/api/health` is asserted `401`. Public provenance asserts `management` is `undefined`.

Caveat (not a leak): `health-contract.ts:89` treats `authMode === "oauth"` as `hasCredential`. Live `google-antigravity` / `github-copilot` have no `auth.json`, so `/api/health` would report them `configured` / `ok`. That contradicts V11 / Lane B / Lane C. Hostname in the auth block is the bind address (Tailscale IP), not a secret.

### Lane C — reconcile defaults to dry-run

**Verdict: default is dry-run; dry-run writes nothing.**

`scripts/state-reconcile.ts:929`:

```ts
mode: rollback ? "rollback" : promote ? "promote" : apply ? "apply" : "dry-run",
```

Dry-run path (`:834–837`) calls `projectedChecks` only. `backupNeeded` is true only for `apply` / `promote`. Promote is the only live writer (`:850–854`).

Re-run:

```text
cd /home/jan/ocx-convergence/lane-c-state
bun test tests/state-reconcile.test.ts
→ 10 pass, 0 fail, 44 expects
```

Includes “dry-run does not write current, staging, or backup” (`wrote=[]`) and “parse args default to dry-run and require legacy.”

### Lane D — no fake Overview metrics

**Verdict: product code did not invent Overview numbers.**

`git diff --name-only origin/main...HEAD` in `lane-d-product`: no `Dashboard.tsx`, no overview page. `rg '4\.2k|98\.1|12 accounts|accounts ready'` under `gui/src/pages`: **no matches**.

The string `12 accounts ready · 18 providers · 2 degraded · 24h: 4.2k req · 98.1% OK` exists only as ASCII wireframe in `DESIGN_CONVERGENCE.md:162`. That is a mock, not a shipped metric.

IA rename (`#overview` etc.) is design-only. `depas.css` deleted (568 lines). Re-run `bun test ./gui/tests/oauth-health-display.test.ts` → **9 pass, 0 fail, 41 expects**.

---

## Per-lane evidence

### A — `4a74ce78` ACCEPT-WITH-CAVEAT

`git log origin/main..HEAD --stat`: 2 commits, 13 files. Gate + docs only.

Caveat is the **retirement sequence**, not the gate. `DEV_RETIREMENT.md` still says `#85` (`f29a58b2`) **must** land on main and “does **not** by itself fix V1.” That is false: `git show origin/dev:.github/workflows/deploy.yml` has `DEPLOY_PATH: /opt/chef/services/opencodex` (line 40). `#85` fixes V1 and V5. It does not fix V6 (no Node 22.12). Lane E / `#90` fix V6.

If an operator follows Lane A after PR2, they will replay `#85` onto a tree that already has Lane E’s `deploy.yml`.

### B — `917c0d0d` ACCEPT

`git log origin/main..HEAD --stat`: 2 commits (audit doc + `tests/provider-engine-audit.test.ts`). Re-run **5 pass, 0 fail, 18 expects**. Antigravity pool “2” = `{enabled, strategy}` keys, **0 accounts**. Matches the corrected snapshot and CONTROL V11.

### C — `c68078d0` ACCEPT

`git log origin/main..HEAD --stat`: 1 commit, 1587 insertions (`STATE_FORENSICS.md`, `scripts/state-reconcile.ts`, tests). Production was not pointed at. Usage counts (174 lines; 108 `anthropic` / 18 `no-such-provider` / 18 `combo`) match V12 addendum 144/174 = 83% synthetic-or-suspect. C did not restate the 83% figure; the arithmetic holds.

### D — `a8d9aeb8` ACCEPT-WITH-CAVEAT

`git log origin/main..HEAD --stat`: 2 commits. Tokens, `StatusBadge`, depas removal, ESLint/CI drift gate. No Overview implementation.

Caveat: `DESIGN_CONVERGENCE.md` §5 says “Merge `#88` into **dev** first.” After Lane A’s gate flip that is the wrong base. PROGRAM_STATUS PR4 retargets `#88` to `main`. Overlap with `#88` (`d8e81893`): `gui/src/pages/Modellen.tsx`, `Verkeer.tsx`, `styles.css`, `styles/depas.css`.

### E — `a4440b97` ACCEPT

`git log origin/main..HEAD --stat`: 1 commit, 5 files (`deploy.yml` +273/−35, publish-on-tag, tests, `DELIVERY_REPAIR.md`, `RELEASE_PROCESS.md`). Special checks above.

L3 still probes `/api/startup-health` + `/api/providers`, not Lane G’s `/api/provenance`. That is correct sequencing (E is PR2, G is PR8). G’s “Lane E must gate L3 on provenance” is a later overlay, not an E defect.

E recommends tagging `v1.2.2` on `6271c7c9`. PROGRAM_STATUS recommends `v1.2.3-preview.1` after PR2+PR3. Operator decision 2 is still open; both docs say do not tag during freeze.

### F — `a508cb71` ACCEPT

Prior Wave 0 packet (`VERIFICATION_WAVE0.md`, `ACCEPTANCE_EVIDENCE.md`) is the baseline this pass re-used. `dev_sha` 778470d6 remains REFUTED; live tip is `07bc1f60`.

### G — `a068bf01` ACCEPT-WITH-CAVEAT

`git log origin/main..HEAD --stat`: 1 commit, 11 files, 984 insertions. Secret check above. Caveat is the OAuth-as-credential heuristic (`health-contract.ts:89`), which will paint the two enabled OAuth providers green on az-01.

`schema_version` reader accepts both `schema_version` and `schemaVersion`. Compatible with Lane C’s camelCase stamp.

### H — `bbeb4ff9` ACCEPT-WITH-CAVEAT

`git log origin/main..HEAD --stat`: 4 commits, `docs/CONTROL.md` only. Topology, bind, V1–V6 / V11–V14 match the snapshot + Lane B/C/F. V1/V2 are correctly described as **current main** defects. After PR2 those two rows must be rewritten or CONTROL becomes the next false authority.

---

## Cross-lane contradictions

### 1. `#85` vs Lane E vs Lane A — **open, merge-blocking if ignored**

| Source | Claim |
|---|---|
| PROGRAM_STATUS PR3 | Drop `#85`; Lane E is the superset |
| Snapshot `dev_commits_to_promote` | `#85` “PARTIAL fix for V5; does NOT fix V1 or V6” |
| Lane A `DEV_RETIREMENT.md` | `#85` **must** land; “does not fix V1 or V6” |
| `origin/dev` `deploy.yml` (re-read) | `DEPLOY_PATH: /opt/chef/services/opencodex` — **V1 is already fixed on `#85`** |
| Lane E | Absorbs `#85` + `#90` + L1–L4 + Node 22.12 |

`#76` / `#86` / `#87` / `#89` do **not** touch `deploy.yml`. `#85` and `#90` (`158cc061`) do.

**Fact correction:** `#85` fixes V1 and V5. It does not fix V6. PROGRAM_STATUS / snapshot / Lane A are wrong about V1.

**Merge implication:** PR3 is safe only if `#85` (and `#90`) stay out. Promoting the five-commit `origin/dev` tip after PR2 replays `deploy.yml` and fights Lane E.

### 2. Antigravity pool count — **resolved**

Original snapshot `googleAntigravityAccountPool: 2` was object-key count. Lane B, Lane C, CONTROL V11, snapshot correction, and V11 addendum all say **0 accounts**, pool `{enabled, strategy}` only. No remaining disagreement.

### 3. `dev` SHA — **resolved**

`778470d6` is an ancestor of both lines (`#29`, 2026-08-06). Live `origin/dev` is `07bc1f60`. Re-verified `git rev-list --left-right --count origin/main...origin/dev` → `0 5`. The five subjects match PROGRAM_STATUS / Lane A / Wave 0.

### 4. `#88` base — **open, file conflict**

Lane D: merge `#88` into `dev` first. Lane A + PROGRAM_STATUS: retarget `#88` to `main`. After PR1, new PRs cannot target `dev`; in-flight `#88` keeps its current base until someone retargets it. Four-file overlap with Lane D (listed above). PROGRAM_STATUS order (PR4 before PR9) is the less-bad sequence.

### 5. Usage 83% — **resolved as arithmetic**

V12 addendum / CONTROL / Lane G: 144/174 = 83%. Lane C’s provider histogram is the same 108+18+18. No contradiction.

### 6. Tag `v1.2.2` vs `v1.2.3-preview.1` — **open operator decision**

Not a code contradiction. Freeze still says do not tag.

### 7. Lane G health vs V11 — **open, GUI lie**

`/api/health` will call live OAuth providers healthy because `authMode === "oauth"`. Do not let Lane D’s Health view treat that as “accounts ready.”

---

## Is PROGRAM_STATUS merge order safe?

**Conditionally yes.**

```text
PR1  lane-a-git          safe — no overlap with E
PR2  lane-e-delivery     safe — stop-the-line; keep dirty+SHA
PR3  #76 #86 #87 #89     SAFE ONLY IF #85 AND #90 ARE DROPPED
PR4  retarget #88        safer before PR9; four-file overlap with D
PR5  lane-c-state        independent
PR6  B follow-up         B tip is tests+docs only; persist work is not in this tip
PR7  usage correctness   not in these tips
PR8  lane-g-contracts    after E is correct (E does not need G endpoints)
PR9  lane-d-product      after #88; do not follow D’s “merge into dev” line
```

Unsafe if someone executes Lane A’s “promote `07bc1f60` / `158cc061`” after PR2. CONTROL.md is not a numbered PR; it must be rewritten after PR2 or it will keep advertising V1/V2 as live defects.

Do not merge a mega-PR. Do not promote `#85` “because Lane A said must land.” Treat PROGRAM_STATUS’s drop-`#85` line as the authority, and treat Lane A’s V1 sentence as a factual error.
