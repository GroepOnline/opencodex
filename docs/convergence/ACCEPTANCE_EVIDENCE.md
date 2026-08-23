# ACCEPTANCE_EVIDENCE — Lane F standard for OCX 3.0 convergence

Other lanes are judged against this file. A checkbox, a screenshot of a passing CI badge, or the sentence “tests pass” is **not** evidence.

Rules:

1. Evidence is a **command + expected output**, a **named test file + pass count**, a **URL + status/body**, a **git object**, or a **dated artefact path**. If it cannot be re-run by Lane F, it does not count.
2. Evidence must name the **SHA, tag, host, and timestamp** it applies to.
3. Production commands are read-only unless a lane’s charter explicitly authorises a mutation; if a mutation is authorised, the evidence packet includes pre-state, the exact command, and post-state.
4. Secret values never appear in evidence. Key **names** and leak **classes** are allowed.
5. `origin/dev` already contains unmerged deploy.yml changes. Evidence for Deploy/Health/Rollback must state whether it was collected against **main’s workflow** or **dev’s workflow**.

---

## Git

**Done means:** the only published history lanes may build on is `GroepOnline/opencodex`, default branch `main`.

| Required artefact | How to produce | Accept |
|---|---|---|
| Remote identity | `git remote -v` in the lane worktree | `origin` fetch/push = `https://github.com/GroepOnline/opencodex.git` (or the org SSH equivalent). |
| Pin to origin/main | `git rev-parse HEAD origin/main` | Both lines equal, and equal to the SHA named in the PR/release notes. |
| No dead-fork mix-in | `git merge-base --is-ancestor e9c4a571 HEAD`; `git log -1 --format='%s' HEAD` | Merge-base with the bitkyc08 lineage is **not** how HEAD was created. Package name in HEAD’s `package.json` is `@groeponline/opencodex`, never `@bitkyc08/opencodex`. |
| Workstation fork unused | `git -C /home/jan/opencodex rev-parse --abbrev-ref HEAD && git -C /home/jan/opencodex rev-list --left-right --count origin/main...HEAD` | Not pushed. If still `38 1324` (or similar), that is **status**, not a fail — fail only if those commits appear on `origin/*`. |

**Reject:** “I used the repo on disk.” Without the two SHAs, Lane F will treat the work as possibly built on `baadc835`.

---

## Branches

**Done means:** integration happens on `dev`; release commits sit on `origin/main`; no local-only production branch name is advertised as authority.

| Required artefact | How to produce | Accept |
|---|---|---|
| Dev vs main count | `git fetch origin && git rev-list --left-right --count origin/main...origin/dev && git log --oneline origin/main..origin/dev` | Counts and subjects printed. Any claim “dev is N ahead” must match this output from the same fetch. |
| Production not on a leaked branch name | On az-01: `cd /opt/chef/services/opencodex && git rev-parse --abbrev-ref HEAD && git ls-remote --heads origin "$(git rev-parse --abbrev-ref HEAD)"` | Either detached HEAD at a **tag SHA**, or a branch that **exists on origin**. `live-v1.2.1` with empty `ls-remote` is a fail. |
| No extra release branch invented | `git ls-remote --heads origin` | New long-lived branches require a written exception in the PR. Feature branches must be PR-headed. |

---

## PRs

**Done means:** every change lands via a PR targeting an allowed base; the allow-list and the release path no longer contradict each other **or** the contradiction is documented in the same PR that changes one side.

| Required artefact | How to produce | Accept |
|---|---|---|
| PR metadata | `gh pr view <n> --json number,title,baseRefName,headRefName,state,mergeStateStatus` | `baseRefName` is in the **then-current** `ALLOWED_BASES`. |
| Allow-list pin | `rg -n 'ALLOWED_BASES' .github/workflows/enforce-pr-target.yml tests/ci-workflows.test.ts` | Workflow and `tests/ci-workflows.test.ts` (today line 742) agree. If `main` is added, the test expectation changes in the **same** PR. |
| CI on that PR | `gh pr checks <n>` or `gh run list --branch <head> --limit 10` | Required checks green on the head SHA. “CI is green on main” does not cover an unmerged head. |

**Reject:** a PR that retargets `main` while `ALLOWED_BASES=["dev"]` still fails the enforcer — unless the PR that changes the allow-list is already merged.

---

## Build

**Done means:** GUI and package build on the **same Node/Bun** that production will use, and the artefact hashes are recorded.

| Required artefact | How to produce | Accept |
|---|---|---|
| Toolchain | `node -v; bun -v` on the build host **and** on az-01 | Production host satisfies `npm view vite@$(jq -r .devDependencies.vite gui/package.json \| tr -d '^') engines` (today: Node `^20.19.0 \|\| >=22.12.0`). Node v18.19.1 is a **fail**. |
| GUI build | `bun run build:gui` (from repo root) with stdout saved | Exit 0. `ls gui/dist/assets/index-*.js gui/dist/assets/index-*.css` shows one JS and one CSS hashed name. |
| Hash card | `sha256sum gui/dist/assets/index-*.js gui/dist/assets/index-*.css` | Digests stored in the PR body. After deploy, `sha256sum` on az-01 `/opt/chef/services/opencodex/gui/dist/assets/index-*.js` **equals** the card (or a documented rebuild on the host with a new card). |
| Frozen install | `bun install --frozen-lockfile` | Exit 0 on the SHA being released. |

**Reject:** “GUI rebuilt by hand on the server” without a hash card. That is the Wave 0 incident, not acceptance.

---

## Backend

**Done means:** the process that answers `:10100` is the SHA under test, started by the documented unit, from the documented path.

| Required artefact | How to produce | Accept |
|---|---|---|
| Unit identity | `systemctl show opencodex-proxy.service -p FragmentPath,ActiveState,ExecStart,WorkingDirectory,NRestarts,ExecMainPID` | `ActiveState=active`; `WorkingDirectory` **equals** the tree that was just deployed; `ExecStart` contains that tree’s `src/cli/index.ts`. |
| SHA | `cd "$WorkingDirectory" && git rev-parse HEAD && git describe --tags --always` | Equals the release tag peel (see Release). |
| Listeners | `ss -lntp \| grep 10100` | Exactly the addresses the health gate will probe. If config `hostname` is `100.109.39.86`, loopback-only evidence is a **fail**. |
| Unauth surface | `curl -sS -D- http://<bound-ip>:10100/healthz` and `curl -sS -o /dev/null -w '%{http_code}' http://<bound-ip>:10100/v1/models` | healthz body contains `"status":"ok"` and `"version":"<released>"`. `/v1/models` is **401** without a key (not 5xx, not HTML). |

---

## Providers

**Done means:** the configured provider set is readable, and at least one live completion proves the data plane.

| Required artefact | How to produce | Accept |
|---|---|---|
| Inventory (counts, no secrets) | On az-01, Python load of `/home/chef/.opencodex/config.json` printing `len(providers)`, `len(disabledModels)`, `schema_version` | Counts printed. `schema_version` present after any data-lane work (absent is a Data fail). |
| Discovery errors | `sudo journalctl -u opencodex-proxy --since '10 min ago' \| rg 'Provider model discovery'` | New 401/400 classes are listed by **provider id only**. A silent empty journal is acceptable only if the unit is readable (`adm`/`systemd-journal` or sudo). |
| Live completion | `curl -sS -H "Authorization: Bearer <redacted>" -H "Content-Type: application/json" http://100.109.39.86:10100/v1/models` | HTTP 200 JSON with a `data` array length ≥ 1. Store **status + model-id list length**, never the bearer token. |
| Failover (if claimed) | Named test file, e.g. a provider-hop test under `tests/` | `bun test <file>` reports `N pass, 0 fail` with N stated. |

**Reject:** `/healthz` 200 as proof that providers work. It is not.

---

## Data

**Done means:** everyone can point to one authoritative store, with a schema version and a counted inventory.

| Required artefact | How to produce | Accept |
|---|---|---|
| Single authority path | Written path in the PR + `stat` of that path on az-01 | One path. If `/etc/chef/opencodex/config.json` still exists, evidence must show it is a **symlink to** the authority file or is removed/ignored by the process (`HOME`/`OPENCODEX_*` documented). Divergent sizes (today 70641 vs 89213) are a **fail**. |
| schema_version | `python3 -c "import json; print(json.load(open('/home/chef/.opencodex/config.json')).get('schema_version'))"` | Non-null string matching the schema doc in the same PR. |
| Inventory card | Same script as snapshot §data.record_counts | providers / disabledModels / apiKeys **counts** (not values). |

---

## Persistence

**Done means:** a restore was practised from a backup that is newer than the last config write.

| Required artefact | How to produce | Accept |
|---|---|---|
| Backup object | `stat` + `sha256sum` of a tarball/snapshot covering `config.json`, `usage.jsonl`, token **paths** (not values), and `gui/dist` hash card | mtime **≥** `config.json` mtime. The Wave 0 `native-binary-seal` (2831 B) does **not** qualify. |
| Scheduler | `systemctl list-timers --all \| rg -i 'opencodex|ocx'` or a crontab line | A timer whose unit name contains `opencodex` or `ocx` and whose `NEXT` is in the future. Authentik/vault timers do not count. |
| Restore drill | Command log: stop is **not** required if restore is into a side path; if production is touched, pre/post `sha256sum config.json` | Restored file digest equals backup digest. “We have `/var/lib/chef/backups`” is a fail (that tree is authentik/vault). |

---

## GUI

**Done means:** the bytes served on `:10100/` are the hash-card build of the released SHA.

| Required artefact | How to produce | Accept |
|---|---|---|
| Served index | `curl -sS http://100.109.39.86:10100/ \| rg -o 'index-[A-Za-z0-9_-]+\.js'` | Filename equals the hash card. |
| Same-origin API | Browser or `curl` of `/api/dashboard` **with** admin auth (token redacted) | 200 JSON. 401 is only acceptable as a **negative** test recorded separately. |
| No secret in bundle | Script equivalent to Wave 0 GUI scan (sk-/sk-ant-/ghp_/JWT/PEM classes) over `gui/dist` | Zero hits, or hits classified as fixtures with file paths. |

**Reject:** a screenshot of the dashboard without the JS filename overlay or curl of the script tag.

---

## Design

**Done means:** the shipped CSS/tokens match the Signaal contract the GUI lane named.

| Required artefact | How to produce | Accept |
|---|---|---|
| Named visual contract | Path to the design doc or CSS entry (`gui/src/styles.css` or successor) in the PR | File exists on the released SHA. |
| Pixel proof | Screenshots **plus** the URL/hash they were taken against | At least dashboard, one traffic/models view, one settings view. Filename includes SHA prefix. |
| No leftover dialect | `rg -n 'depas' gui/src` on the SHA (or the successor grep the GUI lane declares) | Zero, or every hit justified in the PR. |

---

## Responsive

**Done means:** the three viewports were exercised on the **served** bundle, not only `vite preview` on a laptop.

| Required artefact | How to produce | Accept |
|---|---|---|
| Viewport set | Browser (or Playwright) at 360×800, 768×1024, 1440×900 | One screenshot each of `#dashboard` on `http://100.109.39.86:10100/` (tailnet) or the Access-authenticated public URL. |
| No horizontal clip | The screenshot, plus a note of computed `document.scrollWidth <= innerWidth` from the console | Fail if scrollWidth exceeds innerWidth on 360. |

---

## A11y

**Done means:** a named automated run and one keyboard path.

| Required artefact | How to produce | Accept |
|---|---|---|
| Automated | The command the GUI lane already uses (e.g. `bun test` of an a11y file, or `npx react-doctor` as in `gui/package.json`) | Paste the **full tail**: `N pass, 0 fail` or react-doctor exit 0. Name the file. |
| Keyboard | Note: Tab from document start reaches the first nav control; Enter activates it | Screenshot or Playwright trace path stored under `docs/convergence/evidence/` (or the lane’s evidence dir). |

**Reject:** “we used semantic HTML.”

---

## Release

**Done means:** the version string, the git tag, npm, and the release commit are one object.

| Required artefact | How to produce | Accept |
|---|---|---|
| Tag exists | `git ls-remote --tags origin "refs/tags/vX.Y.Z"` | Object present. Annotated or lightweight, but `git rev-parse vX.Y.Z^{}` is the release SHA. |
| Tag on main | `git fetch origin main && git merge-base --is-ancestor vX.Y.Z origin/main` | Exit 0. |
| package.json | `git show vX.Y.Z:package.json \| jq -r .version` | Equals `X.Y.Z` without the `v`. |
| npm | `npm view @groeponline/opencodex version` | Equals `X.Y.Z` **after** publish. Until publish, evidence is the `publish-on-tag` / `release.yml` run URL with conclusion `success`. |
| Commit subject | `git log -1 --format='%s' vX.Y.Z` | `release: vX.Y.Z` or the project’s equivalent. A `release: v1.2.2` commit **without** a `v1.2.2` tag is a **fail** (current main). |

---

## Deploy

**Done means:** the workflow that production will run has run **once green** against the runtime path, on the named host.

| Required artefact | How to produce | Accept |
|---|---|---|
| Workflow identity | `gh api repos/GroepOnline/opencodex/actions/workflows/deploy.yml` | `state=active`. |
| At least one run | `gh api repos/GroepOnline/opencodex/actions/workflows/deploy.yml/runs?per_page=5` | `total_count ≥ 1` and the newest run `conclusion=success` on the tag SHA. **Today `total_count=0` — Deploy DoD is unmet.** |
| Path alignment | `rg -n 'DEPLOY_PATH' .github/workflows/deploy.yml` **and** `systemctl show opencodex-proxy -p ExecStart` | The directory in `DEPLOY_PATH` is the directory in `ExecStart`. `/home/chef/opencodex-psp` vs `/opt/chef/services/opencodex` is a **fail**. |
| Host naming | `rg -n 'chef-control-01' .github/workflows/deploy.yml .github/workflows/publish-on-tag.yml` | Zero hits, or each remaining hit is in a `HISTORICAL` comment that also names az-01. |
| Runner | `gh api repos/GroepOnline/opencodex/actions/runners` | A runner named `ocx-deploy-az-01`, `status=online`, labels include `deploy`. |
| Dirty-tree guard | The run log step “Refuse dirty live checkout” | Conclusion success. If `gui/dist` is gitignored, the run log must still show a **hash-card compare** so a hand-built dist cannot hide. |

---

## Domain

**Done means:** the public name, the Access policy, and the tunnel origin are written down and re-probed.

| Required artefact | How to produce | Accept |
|---|---|---|
| DNS | `dig +short ocx.chefgroep.online A` | Cloudflare anycast (currently 104.18.6.44 / 104.18.7.44) or a documented change. |
| Unauth Access | `curl -sS -o /dev/null -w '%{http_code}' https://ocx.chefgroep.online/healthz` | `302` (or 401) **to** `chefgroep.cloudflareaccess.com`, not 200. A 200 unauthenticated healthz on the public name is a **fail**. |
| Origin | Written triple: tunnel id, connector host, origin URL | Today’s accepted triple: tunnel `27f2c693`, connector `bc-scan-2` (`cloudflared-edge.service` active), origin `http://100.109.39.86:10100`. Evidence: `systemctl is-active cloudflared-edge.service` on bc-scan-2 + `curl -sf http://100.109.39.86:10100/healthz`. |
| Docs domain | `curl -sS -o /dev/null -w '%{http_code}' https://opencodex.chefgroep.online/` | `200` if docs are in scope for that release. |

**Reject:** “ingress is Cloudflare” without the connector host.

---

## Health L1–L4

Levels are cumulative. A higher level without the lower is a fail.

| Level | Question | Required artefact | Accept |
|---|---|---|---|
| **L1 Process** | Is the unit up? | `systemctl is-active opencodex-proxy.service && systemctl show -p NRestarts,ActiveEnterTimestamp` | `active`. `NRestarts` explained if > 0 since last deploy. |
| **L2 Bind + healthz** | Does healthz answer on every address the gate uses? | For each URL in deploy.yml’s health step: `curl -sf --max-time 5 <url>` | Body matches `/"status"\s*:\s*"ok"/` and `"version"` equals the released version. **Loopback-only success while `ss` shows only the tailscale bind is a fail.** |
| **L3 Data plane** | Does the OpenAI-compatible API work? | `curl -sS -H "Authorization: Bearer <redacted>" http://<bound>:10100/v1/models` | HTTP 200, JSON `data` length ≥ 1. Record length + first model id. |
| **L4 Public edge** | Does the internet path still enforce Access and, after auth, reach the same pid? | Unauth: 302 (Domain). Auth: `cloudflared access curl` **or** an Access service-token curl (token redacted) of `https://ocx.chefgroep.online/healthz` | 200 body with the **same `pid`** as L2 (proves edge and origin are the same process). |

**Reject:** L2 as a deploy gate without L3. That is the current `deploy.yml` defect.

---

## Rollback

**Done means:** a practised failure path returned production to a recorded SHA **and** L2+L3 still passed.

| Required artefact | How to produce | Accept |
|---|---|---|
| Pre-state card | SHA, `gui/dist` JS hash, `config.json` sha256, unit ActiveEnterTimestamp | Stored before the drill. |
| Drill | A `workflow_dispatch` or tag of a **deliberately failing** ref, **or** a documented dry-run that trips the health step | `gh run view <id> --log` shows the “Rollback on failure” step ran (`conclusion` of that step success). |
| Post-state | Repeat the pre-state card | SHA and config digest equal the pre-state. JS hash equal unless the rollback rebuild is documented. L3 still 200. |
| Path correctness | Rollback `cd` directory | Same directory as `ExecStart`. Rolling back `/home/chef/opencodex-psp` while bun executes `/opt/chef/services/opencodex` is a **fail**, even if the step is green. |

**Today:** no run exists. Rollback DoD is unmet. The first green deploy is **not** a substitute.

---

## Telemetry

**Done means:** usage and errors from the released SHA are being written, without leaking secrets.

| Required artefact | How to produce | Accept |
|---|---|---|
| usage.jsonl | `wc -l /home/chef/.opencodex/usage.jsonl; stat -c '%y' …` | Line count **increased** (or a documented zero-traffic window) after a L3 probe. |
| Journal hygiene | `sudo journalctl -u opencodex-proxy -n 200` scanned for the Wave 0 secret classes | Zero hits. A hit is stop-the-line until rotated and the log line class/location filed. |
| telemetry-id | `stat /home/chef/.opencodex/telemetry-id.txt` | File exists; contents not pasted. |

---

## Docs

**Done means:** a new operator can find host, path, bind, ingress, and backup from the repo **at the released SHA**.

| Required artefact | How to produce | Accept |
|---|---|---|
| Runtime SSOT page | A file on the SHA (path named in the PR) | Lists: host `chef-control-az-01`, path `/opt/chef/services/opencodex`, bind `100.109.39.86:10100` (or the new bind), tunnel `27f2c693` / `bc-scan-2`, data `/home/chef/.opencodex`. |
| Stale host names | `rg -n 'chef-control-01' README.md docs/ .github/workflows/` | Zero unannotated hits. |
| Ingress | The Domain triple copied into that SSOT page | Matches the live units. |

---

## Drift

**Done means:** live tree, tag, npm, and deploy-path cannot silently diverge again.

| Required artefact | How to produce | Accept |
|---|---|---|
| Triple SHA | `git rev-parse HEAD` on az-01 runtime, `git rev-parse vX.Y.Z^{}`, `npm view @groeponline/opencodex version` | All three name the same version; runtime SHA equals tag peel. |
| Second checkout | `git -C /home/chef/opencodex-psp rev-parse HEAD` | Either the directory is **gone**, or it is a documented mirror of the runtime SHA (not 16 commits ahead). Today psp@4a589932 vs runtime@71c3cad1 is **drift**. |
| GUI | Hash card vs live `gui/dist` | Equal. |
| Config copies | `sha256sum /home/chef/.opencodex/config.json /etc/chef/opencodex/config.json` | Equal, or the `/etc` file is absent/symlink. |

---

## Cleanup

**Done means:** leftover authorities that could be mistaken for production are gone or labeled.

| Required artefact | How to produce | Accept |
|---|---|---|
| Legacy checkouts | `ls -ld /opt/chef/services/.opencodex-backup-20260822T095647Z /opt/chef/services/opencodex.pre-git-20260822T133750Z` | `ls: cannot access` **or** a `README.OFFLINE` in each plus an inventory row that they are not started (`ss` still only one `:10100`). |
| Token copies | `ls /home/chef/.opencodex/admin-api-token*` | Only the live token path remains, or `.bak` is in a root-owned secrets dir. Presence of `admin-api-token.bak-pre-control-20260804` is a **fail** after the cleanup lane. |
| Dead host references | `rg -n 'chef-control-01' .github docs README.md` | As Docs. |
| Workstation fork | Written decision: leave `/home/jan/opencodex` untouched, or relocate it off `main` | `git -C /home/jan/opencodex branch -m main local/dead-fork-bitkyc08` is acceptable evidence **only if** the user asked for that mutation. Until then, “do not push” in the runbook is the artefact. |

---

## Packet shape Lane F will accept

A lane’s final comment or `docs/convergence/<LANE>_EVIDENCE.md` must contain, for each DoD category it claimed:

```text
CATEGORY: <name>
SHA: <40 hex>
HOST: <or "n/a">
COMMAND: <exact>
OUTPUT: <paste, secrets redacted>
VERDICT: pass|fail
```

Missing `COMMAND`/`OUTPUT` → Lane F marks UNVERIFIABLE, which blocks merge the same as fail.
