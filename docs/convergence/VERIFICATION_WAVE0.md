# VERIFICATION_WAVE0 — Lane F independent re-derivation

**Authority:** Lane F (verification only). This document is a verdict, not a fix.
**Verifier worktree:** `/home/jan/ocx-convergence/lane-f-verify` (`convergence/lane-f-verify`)
**Claim under test:** `/home/jan/ocx-convergence/evidence/OCX_STATE_SNAPSHOT.yaml` (captured 2026-08-23T11:20:00Z)
**Re-verify window:** 2026-08-23 11:23–11:35 UTC
**Mutations:** none on production, none on `origin/*`, none outside `docs/convergence/`.
**Secrets:** names and classes only. No `service.env` contents, tokens, cookies, or JWT bodies are reproduced here.

Verdict vocabulary:

| Verdict | Meaning |
|---|---|
| CONFIRMED | Independently re-derived; claim is accurate |
| CONFIRMED-WITH-CAVEAT | Directionally true; precision is off in a way other lanes must know |
| REFUTED | Independently re-derived; claim is false |
| UNVERIFIABLE | Could not obtain independent evidence without mutation, extra privilege, or a secret |

---

## 1. Claim-by-claim verdicts

### 1.1 Git / GitHub

| Claim | Snapshot value | Verdict | Command / observed |
|---|---|---|---|
| repo | GroepOnline/opencodex | CONFIRMED | `git remote -v` → `https://github.com/GroepOnline/opencodex.git` |
| default_branch | main | CONFIRMED | `git symbolic-ref refs/remotes/origin/HEAD` → `refs/remotes/origin/main`; `gh api repos/GroepOnline/opencodex --jq .default_branch` → `main` |
| main_sha | 4a589932da38f65cffeac0e8b364322fd026c094 | CONFIRMED | `git log -1 --format='%H' origin/main` |
| main_date | 2026-08-18 | CONFIRMED | `git log -1 --format='%ci' origin/main` → `2026-08-18 20:50:05 +0200` |
| main_package_version | 1.2.2 | CONFIRMED | `git show origin/main:package.json` → `@groeponline/opencodex` `1.2.2` |
| `release: v1.2.2` on main | implied by V3 | CONFIRMED | `git log origin/main --grep='release:' -1` → `6271c7c9 release: v1.2.2 (GRO-1383)` (parent of the docs commit that is HEAD of main) |
| dev_sha | `778470d6` | **REFUTED** | After `git fetch origin --tags --prune`: `git rev-parse origin/dev` → `07bc1f60476060ebb9e416ef2dc0e68e87497d84` (`docs(gui): v2 Devin-richting → v3 Signaal (#89)`, 2026-08-22 23:44:47 +0200). `778470d6` exists but is **2026-08-06** `feat(release): link release commits to Linear issues (#29)` — not `origin/dev`. |
| dev_vs_main | 5 ahead, 0 behind | CONFIRMED | `git rev-list --left-right --count origin/main...origin/dev` → `0 5`. The five commits: `07bc1f60` #89, `c5a2d15d` #87, `f29a58b2` #85, `3722e7b9` #86, `c06ae3a0` #76. |
| remote_branch_count | 20 | CONFIRMED-WITH-CAVEAT | `git branch -r \| wc -l` → `20` **including** `origin/HEAD -> origin/main`. Unique remote branches: **19**. |
| open PR 88 | title / base `dev` / head `fix/signaal-drift-cleanup` | CONFIRMED | `gh pr list --repo GroepOnline/opencodex --state open` |
| open PR 90 | title / base `dev` / head `fix/azure-gui-deploy-lane` / files `deploy.yml` + `tests/ci-workflows.test.ts` | CONFIRMED | Same `gh pr list` JSON; files match. Two open PRs, both targeting `dev`. |
| latest_tag | v1.2.1 | CONFIRMED-WITH-CAVEAT | `git describe --tags origin/main --abbrev=0` → `v1.2.1`. GitHub `/tags` lists `v2.7.33` first (pre-rebrand lineage). `v1.2.1` is the latest tag **on the current 1.2 product line**, not the highest semver tag in the repo. |
| latest_tag_sha | 71c3cad1d04a017aada96e0c0f58d00a277a8a2e | CONFIRMED | `git log -1 --format='%H' v1.2.1` (annotated tag `3e4267d4` peels to this commit) |
| v1_2_2_tag_exists | false | CONFIRMED | `git rev-parse --verify --quiet v1.2.2` → missing; `git ls-remote --tags origin refs/tags/v1.2.2` empty |
| main ahead of v1.2.1 | 16 commits (V3) | CONFIRMED | `git rev-list --count v1.2.1..origin/main` → `16`; `git merge-base --is-ancestor v1.2.1 origin/main` succeeds |
| npm latest | implied 1.2.1 | CONFIRMED | `npm view @groeponline/opencodex version` → `1.2.1`; dist-tag `latest` = `1.2.1` |
| deploy.yml runs ever | 0 | CONFIRMED | `gh api repos/GroepOnline/opencodex/actions/workflows/deploy.yml/runs?per_page=5` → `{total_count: 0, runs: []}` |
| deploy runner | ocx-deploy-az-01 online, labels `[self-hosted, Linux, X64, deploy, opencodex]` | CONFIRMED | `gh api repos/GroepOnline/opencodex/actions/runners` |
| local workstation `main` | baadc835 / `@bitkyc08/opencodex` / `1.0.0-alpha.1` / 38 ahead 1324 behind / merge-base `e9c4a571` | CONFIRMED | Read-only inspection of `/home/jan/opencodex` (see V7). |

**Wave 0 error that would misdirect other lanes:** treat `origin/dev` as `07bc1f60`, not `778470d6`. Planning against the stale SHA would ignore five already-merged-to-dev commits, including `#85` which already retargets deploy.yml at Azure (see §3).

### 1.2 Production host / service

| Claim | Snapshot value | Verdict | Command / observed |
|---|---|---|---|
| host | chef-control-az-01, TS `100.109.39.86` | CONFIRMED | `ssh chef-control-az-01 hostname` → `chef-control-az-01`; `tailscale status` → `100.109.39.86 chef-control-az-01` |
| host_previous | chef-control-01 offline ~1d | CONFIRMED | `tailscale status --json`: HostName `chef-control-01`, `Online=False`, `LastSeen=2026-08-22T01:31:44.1Z`. CLI display name is `chef-control-01-1`. |
| service | opencodex-proxy.service, description “OpenCodex Proxy Server (Azure authority)”, active | CONFIRMED | `systemctl status opencodex-proxy.service` — enabled, active (running) since 2026-08-23 02:55:28 UTC, Main PID 413295 (`bun`) |
| runtime_path | `/opt/chef/services/opencodex` | CONFIRMED | unit `WorkingDirectory=` and `ExecStart` `bun …/opt/chef/services/opencodex/src/cli/index.ts start --port 10100` |
| runtime_sha / version | 71c3cad1 / 1.2.1 | CONFIRMED | `git rev-parse HEAD` in that tree; `package.json` `1.2.1`; `/healthz` `"version":"1.2.1"` |
| runtime_branch | `live-v1.2.1` local-only | CONFIRMED | `git branch -vv` → `* live-v1.2.1 71c3cad1d`; `git ls-remote --heads origin live-v1.2.1` empty; live checkout has **no other local branches and no `origin/main` ref fetched** |
| runtime_dirty | false | CONFIRMED-WITH-CAVEAT | `git status --porcelain` empty; `git ls-files --others --exclude-standard` empty. `gui/dist` is **gitignored** (`gui/.gitignore:11:dist`) and was rebuilt 2026-08-23 02:55. Git is clean; the served GUI is a live-only artefact (see §3). |
| runtime_live_only_commits | 0; SHA ancestor of origin/main; 16 behind | CONFIRMED from workstation; UNVERIFIABLE from the live checkout | Workstation: `git merge-base --is-ancestor v1.2.1 origin/main` + 16-commit count. Live: `git merge-base --is-ancestor HEAD origin/main` fails because `origin/main` is **not present** in that clone. |
| deploy_workflow_path | `/home/chef/opencodex-psp` @ 4a589932 / 1.2.2 | CONFIRMED | `cd /home/chef/opencodex-psp && git rev-parse HEAD` → `4a589932…`; branch `main...origin/main`; package `1.2.2` |
| listener | `100.109.39.86:10100` only | CONFIRMED | `ss -lntp \| grep 10100` → `LISTEN 100.109.39.86:10100` pid 413295. No bind on `127.0.0.1`, `0.0.0.0`, or Azure NIC `10.42.1.4`. |
| health via tailscale | `status=ok` version 1.2.1 port 10100 | CONFIRMED-WITH-CAVEAT | `curl http://100.109.39.86:10100/healthz` → `{"status":"ok","service":"opencodex","version":"1.2.1","uptime":…,"pid":413295,"port":10100}`. Snapshot omitted `uptime` and `pid`. |
| health via loopback | connection refused | CONFIRMED | On-host `curl http://127.0.0.1:10100/healthz` → `Failed to connect … Couldn't connect to server` (http=000) |
| root HTTP via tailscale | 200 | CONFIRMED | `curl -o /dev/null -w '%{http_code}' http://100.109.39.86:10100/` → `200` (`<!doctype html>`) |
| node_version | v18.19.1 | CONFIRMED | `node -v` on az-01 → `v18.19.1` (`/usr/bin/node`) |
| bun_version | 1.4.0 | CONFIRMED | `bun -v` → `1.4.0` (unit ExecStart uses `/home/chef/.bun/bin/bun`) |
| Vite requires Node ≥20.19 \|\| ≥22.12 | V6 | CONFIRMED | `npm view vite@8.1.0 engines` → `{"node":"^20.19.0 \|\| >=22.12.0"}`; `gui/package.json` has `vite: ^8.1.0` |
| public_domain | ocx.chefgroep.online → 302 Cloudflare Access | CONFIRMED | `dig +short` → `104.18.6.44` / `104.18.7.44` (Cloudflare). `curl -I https://ocx.chefgroep.online/` → HTTP/2 302 `location: https://chefgroep.cloudflareaccess.com/cdn-cgi/access/login/…`; `server: cloudflare`. |
| docs_domain | opencodex.chefgroep.online HTTP 200 | CONFIRMED | `curl -o /dev/null -w '%{http_code}' https://opencodex.chefgroep.online/` → `200` |
| ingress_mechanism | UNKNOWN (no cloudflared/nginx on host) | CONFIRMED on the authority host; **UNDERSTATED as a programme premise** | No `cloudflared`/`nginx`/`caddy` binary or unit on az-01; no `:80`/`:443` listener; Azure public `135.225.88.53:{80,443,10100}` times out. The path **is** a Cloudflare named tunnel — see §3 / V10. |
| deploy_runner_unit | ocx-deploy-runner.service | CONFIRMED | active since 2026-08-22 23:15:38 UTC; `Listening for Jobs`; runner version 2.336.0 |

**Bind mechanism Wave 0 did not state:** `/home/chef/.opencodex/config.json` has `"hostname":"100.109.39.86"` and `"port":10100`. That is why loopback is refused. deploy.yml’s comment (“the proxy binds it regardless of any LAN hostname, so the loopback probe is stable”) is **false on this host**.

### 1.3 Data

| Claim | Snapshot value | Verdict | Command / observed |
|---|---|---|---|
| engine | none — JSON/JSONL on disk | CONFIRMED | No `*.sqlite*` under `.opencodex` or the runtime tree; `postgresql`/`mysqld`/`redis-server` inactive |
| location | `/home/chef/.opencodex` | CONFIRMED-WITH-CAVEAT | Live process `HOME=/home/chef`. **Second copy** `/etc/chef/opencodex/config.json` exists (70641 bytes, mtime 2026-08-22 06:34, fewer keys). They have diverged. |
| schema_version | absent | CONFIRMED | `python3` load of config.json → `schema_version ABSENT` |
| config.json size / mtime | 89213 / 2026-08-22 10:10 | CONFIRMED | `stat` 89213 bytes, `2026-08-22 10:10:52Z` |
| top_level_keys | listed 27 keys | CONFIRMED | Exact match of the snapshot list |
| record counts | providers 18, caps 7, subagentModels 4, disabledModels 876, apiKeys 1, antigravity pool 2, combos 1 | CONFIRMED | Same counts. `apiKeys` is **not** a dict (`apiKeys_is_dict False`) — a list of length 1. |
| usage.jsonl | 174 lines, mtime 2026-08-22 10:07 | CONFIRMED | `wc -l` → 174; mtime `2026-08-22 10:07:32Z` |
| other named files | admin tokens, catalog backups, responses-state, etc. | CONFIRMED, incomplete | All named files exist. Wave 0 **omitted**: `SETUP.md`, `artifacts/`, `claude-launcher/`, `kimi-device-id`, `mimo-client-id`, three `patch-*.sh`, `winsw/`, `service-api-token` symlink → `/etc/chef/opencodex/service-api-token`. |
| codex_home | `/home/chef/.codex` + four large/small files | CONFIRMED | `config.toml`, `models_cache.json` 2 782 715 B, `opencodex-catalog.json` 2 782 646 B, `opencodex-journal.json`, plus `opencodex.config.toml` (not named in the snapshot) |
| secrets_location | `/etc/chef/opencodex/service.env` + LoadCredential api-token | CONFIRMED | Unit: `EnvironmentFile=-/etc/chef/opencodex/service.env`, `LoadCredential=api-token:/etc/chef/opencodex/service-api-token`. File is `root:root` `0600` — chef cannot read values. Process environ **key names** (not values) include `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `CF_ACCESS_ALLOWED_HOSTS` plus 11 `*_API_KEY` names. Snapshot “16+ provider API keys” is **UNVERIFIABLE** from the file and **overstated vs the live process env** (11 `*_API_KEY` keys). |
| backups_on_host | native-binary-seal, “20K” | CONFIRMED-WITH-CAVEAT | Path exists. `du -sb` → **2831 bytes**; `du -sh` → **16K**. “20K” is inflated. Contents are a binary seal, not a config backup. |
| scheduled OCX backup | none | CONFIRMED | `systemctl list-timers` shows `chef-authentik-backup.timer` and `chef-vault-backup.timer` only. No user crontab matches. `/var/lib/chef/backups` holds **authentik + vault** only. |
| legacy `.opencodex-backup-20260822T095647Z` | older layout, AGENTS.md / coderabbit / gitmodules | CONFIRMED | Has those files; `package.json` `@groeponline/opencodex` **1.1.1**; no `.git` |
| legacy `opencodex.pre-git-20260822T133750Z` | npm-installed, no .git | CONFIRMED | no `.git`; package **1.2.1** |
| chef-control-01 state | UNREACHABLE | CONFIRMED | host offline; `:10100` curl times out |
| `/var/lib/chef/{backups,rollback}` | not enumerated | **now enumerated** | backups = authentik + vault. rollback = two `systemd-units-20260823T03…` snapshots of authentik/vault units. **No OCX state.** |

### 1.4 Frontend

| Claim | Snapshot value | Verdict | Command / observed |
|---|---|---|---|
| build in place 2026-08-23 02:55 | manual rebuild | CONFIRMED | `stat` on `gui/dist/*` → `2026-08-23 02:55:28Z`; service ActiveEnterTimestamp is the same second |
| bundle | index-BjvHCBV1.js, index-CakxJCQf.css | CONFIRMED | `gui/dist/assets/index-BjvHCBV1.js` 777 554 B sha256 `37895730ce16475a…`; `index-CakxJCQf.css` 155 799 B |
| fonts | general-sans-400/500/600 | CONFIRMED | plus JetBrains Mono woff2 set |
| API_base same-origin | proxy serves gui/dist | CONFIRMED | `/` and `/index.html` return the GUI HTML on `:10100` |
| known_incident Node 18 / build:gui | | CONFIRMED as current host constraint | Node is still v18.19.1; Vite 8.1.0 engines reject it. Historical “dashboard.available=false” is **UNVERIFIABLE** from live artefacts now (current `/` is 200 HTML). |

---

## 2. The ten violations — verdict and calibration

### V1 — deploy path ≠ runtime path — CONFIRMED, not overstated

On **origin/main** (what production deploy.yml would run today):

```text
DEPLOY_PATH: /home/chef/opencodex-psp          # deploy.yml:39
ExecStart: bun /opt/chef/services/opencodex/src/cli/index.ts start --port 10100
```

A successful deploy updates a checkout that systemd does not execute. Severity `critical` is correct.

**Understatement / planning note:** `origin/dev` already changes this. `git show origin/dev:.github/workflows/deploy.yml` has `name: Deploy to chef-control-az-01` and `DEPLOY_PATH: /opt/chef/services/opencodex` (`f29a58b2` / PR #85, plus PR #90 still open). Do not plan a second, conflicting path-fix on main without reconciling those commits.

### V2 — health gate loopback vs tailscale bind — CONFIRMED, not overstated

`deploy.yml` health-gate and rollback both curl `http://127.0.0.1:10100/healthz`. On-host loopback is refused. The gate **cannot** pass on the current bind.

Root cause (missed by Wave 0): config `hostname` is the tailscale IPv4, not `127.0.0.1` / `0.0.0.0`.

**Understatement:** even a “fixed” loopback probe would still be a shallow L2 check (see stop-the-line). `origin/dev` already probes loopback **and** the discovered Tailscale IPv4.

### V3 — release v1.2.2 without tag; deploy never ran — CONFIRMED

- main package + release commit = 1.2.2
- no `v1.2.2` tag on the remote
- npm `latest` = 1.2.1
- production = 1.2.1 @ 71c3cad1
- `deploy.yml` `total_count: 0`

Severity `high` is correct. The operational consequence is stronger than “tag missing”: **no automated deploy has ever been proven**, so rollback, health-gate, and GUI-build-on-host are all untested in CI (see §4).

### V4 — ALLOWED_BASES=["dev"] vs main as default/release — CONFIRMED

`.github/workflows/enforce-pr-target.yml:49` `const ALLOWED_BASES = ["dev"];` pinned by `tests/ci-workflows.test.ts:742`. Comments say this is intentional (dev = integration, main = promotion-only). `publish-on-tag.yml` still requires the tag commit on `origin/main`; `deploy.yml` refuses tags that are not ancestors of `origin/main`.

Not overstated as a **governance contradiction**. Slightly overstated if read as “a bug in the allow-list” — the allow-list matches the stated PR policy. The defect is that **release/deploy policy and PR policy are two different theories of `main`**, encoded in different workflows.

### V5 — chef-control-01 still named; real authority is az-01 — CONFIRMED

`deploy.yml` header, concurrency group `ocx-deploy-control-01`, and `publish-on-tag.yml` still name chef-control-01. The live runner is `ocx-deploy-az-01` on chef-control-az-01. The UpCloud host is offline.

**Understatement:** `origin/dev` already retitles the workflow to az-01 and marks control-01 retired. Main does not have that yet.

### V6 — host Node 18 vs Vite; live GUI hand-rebuilt — CONFIRMED

Host Node v18.19.1 < Vite 8.1.0 engines. Service start timestamp equals `gui/dist` mtime (2026-08-23 02:55:28Z). This is an out-of-band production mutation.

**Quantify the artefact (Wave 0 missed):**

| Tree | JS bundle | bytes | when |
|---|---|---|---|
| live `/opt/chef/services/opencodex/gui/dist` | `index-BjvHCBV1.js` | 777 554 | 2026-08-23 02:55 |
| deploy-path `/home/chef/opencodex-psp/gui/dist` | `index-ALO7OtBQ.js` | 765 652 | 2026-08-22 06:34 |
| tag `v1.2.1` git tree | *(none — `gui/dist` gitignored, 0 tracked files)* | 0 | n/a |

CSS hash `index-CakxJCQf.css` is identical across live and deploy-path. JS filename and size differ (+11 902 B on live). Entire `gui/dist` is 54 files / 1 269 816 bytes, all untracked. A clean checkout of `v1.2.1` has **no** `gui/dist`; the production GUI cannot be reproduced from the tag without a build.

### V7 — workstation `main` is a dead fork lineage — CONFIRMED, not overstated

Read-only `/home/jan/opencodex`:

```text
branch: main
HEAD:   baadc8355e9127a40d267e03a9dce4cab071f13e
pkg:    @bitkyc08/opencodex 1.0.0-alpha.1
vs origin/main: 38 ahead / 1324 behind
merge-base: e9c4a5711e52ffa751ed872a9e543a8b80f3e4cd  (2026-07-22)
```

Must never be pushed. Convergence work on this worktree (`4a589932` = `origin/main`) is the correct lineage.

### V8 — unversioned JSON, no scheduled backup, legacy unreconciled — CONFIRMED

Accurate. Calibration:

- Native “backup” is a 2.8 KB binary seal, not a restore of `config.json`.
- `/var/lib/chef/backups` is **not** an OCX backup location.
- Dual config (`/etc/chef/opencodex/config.json` 70 641 B vs `~/.opencodex/config.json` 89 213 B) is an extra unreconciled store Wave 0 did not call out.
- Offline chef-control-01 / sofie state remains unreachable — residual unknown, not a second live authority.

### V9 — live-v1.2.1 local branch vs pinned detached SHA — CONFIRMED

Accurate. Additional fact: the live clone is a single-branch checkout with no `origin/main`, so the deploy.yml “HEAD is ancestor of tag” guard would need a fetch before it could even evaluate ancestry.

### V10 — public ingress unexplained — CONFIRMED on az-01, **UNDERSTATED as UNKNOWN**

Wave 0 correctly observed: no cloudflared/nginx on the authority host, domain still answers via Cloudflare. That is not the same as “path unknown to the organisation.”

**Independently established topology (2026-08-23):**

```text
Internet
  → Cloudflare DNS (104.18.6.44 / 104.18.7.44) + Access
      (unauth https://ocx.chefgroep.online/* → 302 chefgroep.cloudflareaccess.com)
  → named tunnel 27f2c693  (cloudflared-edge.service)
  → connector host bc-scan-2 (100.65.83.86)
       units (observed active):
         cloudflared-edge.service
           "Cloudflare Tunnel - public edge 27f2c693 (kater/vault/auth/sync)"
           ExecStart: cloudflared … tunnel run --token-file /etc/cloudflared/edge-27f2.token
         chef-control-tunnel.service
           "Chef control plane Cloudflare Tunnel connector"
  → Tailscale origin http://100.109.39.86:10100   (az-01, hostname-bound)
```

Supporting evidence (docs, treated as claims until the units were seen):

- ChefFactory `docs/plans/2026-08-22-ocx-edge1-proof.md`: CF ingress for `ocx.chefgroep.online` → `http://100.109.39.86:10100`; connector path `bc-scan-2`.
- ChefFactory `docs/platform/network-planes.md`: same row; historical origin was `100.115.43.1:10100` (retired control-01).
- `src/server/cf-access-auth.ts`: `CF_ACCESS_*` **validate** Access JWTs for the management GUI. They do **not** create the tunnel. Data-plane `/v1/*` stays on the service API token.

**Still unknown / not independently closed:**

- The live Cloudflare ingress *JSON* (hostname → origin) was not read from the Cloudflare API (would need account credentials). Connector + docs + origin reachability are consistent; a silent CF-side drift back to `100.115.43.1` cannot be disproved from az-01 alone (that host is offline, so such drift would 502).
- Laptop `ocx-tunnel` (SSH `-W 100.109.39.86:10100`) is documented as the operator dashboard path. It is **inactive** on this workstation (`systemctl --user is-active ocx-tunnel.socket` → inactive; no local `:10100`).
- `chefgroep` / `chefgroep-1` SSH was refused/timed out; not fully inspected.

V10 severity `medium` is **understated for operations** (the public door depends on a **different host** than the runtime authority, and that host also carries kater/vault/auth/sync). For OCX-only convergence it is still medium: runtime does not own its ingress.

---

## 3. What Wave 0 missed

### 3.1 Ingress (see V10)

The snapshot stopped at “not on az-01.” The connector is on **bc-scan-2**. CF_ACCESS env vars are JWT admission for the GUI, not the hop. Historical origin `100.115.43.1:10100` was flipped (docs, 2026-08-22 EDGE1); other hostnames on the same tunnel (`auth`, `kater`, `sync`) are **still documented as pointing at the retired host** — out of OCX scope but it means tunnel `27f2c693` is a shared blast radius.

### 3.2 Live-only divergence beyond git

- **No live-only commit.** HEAD is exactly tag `v1.2.1` (`71c3cad1`).
- **Live-only GUI.** `gui/dist` gitignored; 54 files; JS bundle name/size differ from the deploy-path tree; tag tree has zero dist files.
- **Live-only config drift vs `/etc`.** 89 213 B vs 70 641 B.
- **Live clone shape.** Single local branch, no `origin/main`.

### 3.3 Competing OCX runtime — no second live authority found

`:10100/healthz` from this workstation:

| Host | TS IP | Result |
|---|---|---|
| chef-control-az-01 | 100.109.39.86 | **200** OCX 1.2.1 pid 413295 |
| chef-platform-aws-01 | 100.100.163.100 | connect refused |
| chefgroep / chefgroep-1 | 100.92.10.92 / 100.109.230.83 | timeout / refused |
| github-k3s-lab-01 | 100.68.55.44 | refused; `cloudflared` inactive; no ocx ingress |
| udo-control-plane-01 | 100.107.105.123 | refused; no ocx/cloudflared units |
| joep, weg54, bc-*, jan | various | refused |
| chef-control-01 | 100.115.43.1 | timeout (offline) |
| chef-runner-01 | 100.111.187.17 | timeout (offline) |

SSH to aws-01 / udo / k3s: no `opencodex` paths or units. sofie historically hosted OCX and was drained (ChefFactory migration notes); `sofie` is offline.

**Verdict:** not stop-the-line. One live OCX data-plane on az-01:10100. Residual: offline hosts cannot be inspected; a process on a non-10100 port was not exhaustively hunted.

### 3.4 Secret hygiene (class + location only)

| Class | Location | Verdict |
|---|---|---|
| Provider API keys (env) | `/etc/chef/opencodex/service.env` (root 0600); process environ of pid 413295 | Stored as designed. Values not read. 11 `*_API_KEY` names visible via `/proc/PID/environ` **key list**. |
| Management API token | systemd LoadCredential `api-token` ← `/etc/chef/opencodex/service-api-token` | Designed. |
| Management/admin token copies | `/home/chef/.opencodex/admin-api-token` and `admin-api-token.bak-pre-control-20260804` (mode 0600); symlink `service-api-token` → `/etc/chef/opencodex/service-api-token` | **Hygiene problem:** token material lives in the mutable data dir and a `.bak`. Class = admin/management token. Values not printed. |
| Cloudflare Access config | process env `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` / `CF_ACCESS_ALLOWED_HOSTS` | Names only. AUD is an application id, not a provider key, but must not be copied into git. |
| Journal token leak | `sudo journalctl -u opencodex-proxy -n 200` (chef has NOPASSWD; unprivileged journalctl is empty) | **No** matches for sk-/sk-ant-/ghp_/JWT/PEM/Bearer/api-key-assignment classes in those 200 lines. |
| GUI bundle | `/opt/chef/services/opencodex/gui/dist/**/*.js` | **No** secret-class matches. |
| Git tree (this pin) | worktree @ 4a589932 | One PEM: **test fixture** `tests/gcp-adc.test.ts` (`-----BEGIN PRIVATE KEY-----` for `svc@example.test`). Not a production leak. |
| Unauthenticated API | `/healthz`, `/`, `/v1/models`, `/api/*` | `/v1/models` → 401 `opencodex API key required`; `/api/*` → 401 `opencodex admin token required`. No key material in bodies. |
| Public Access login URL | `curl https://ocx.chefgroep.online/` | Returns Access 302 with JWT **metadata** in the query string. Not a provider key; still should not be archived in tickets. |

### 3.5 Restart / retain state (service was **not** restarted by this lane)

| Probe | Observed |
|---|---|
| `Restart=` | `always`, `RestartSec=5` |
| `NRestarts` (current invocation) | `0` |
| `ActiveEnterTimestamp` | 2026-08-23 02:55:28 UTC (~8h uptime at verify) |
| `Result` / `ExecMainStatus` | success / 0 |
| Journal crash loop? | Three rapid `exit-code` failures at **2026-08-22 06:34:06–17Z** — `bun` printed `Usage: ocx start [--port <port>]` (wrong argv on first unit). Then the unit was rewritten to “Azure authority” and stayed up. Later PID changes (06:34, 07:19, 09:56, 09:57, 13:11, 13:37, 19:38, 23:15, 02:55) match **manual/unit restarts on migration day**, not a current crash loop. No OOM/killed lines in the scanned window. |
| State retention across those restarts | `config.json` mtime 2026-08-22 10:10 survived later restarts; `usage.jsonl` 174 lines last write 10:07; pid/port files rewritten at 02:55. **Not a restart test** — only archaeological. |

---

## 4. Stop-the-line conditions

| Condition | Verdict now | Evidence |
|---|---|---|
| Unknown live-only **commit** | **CLEAR** | Live HEAD = `v1.2.1` = `71c3cad1`, ancestor of `origin/main` (16 behind). |
| Unknown live-only **artefact** | **OPEN (not STL)** | gitignored `gui/dist` + `/etc` config copy. Must be inventoried before any force-checkout. |
| Unknown data location | **CLEAR for primary; OPEN for replicas** | Primary is `/home/chef/.opencodex`. Replicas: `/etc/chef/opencodex/config.json`, two legacy checkouts, unreachable control-01/sofie. No SQLite/Postgres. |
| Migration without backup | **OPEN — do not migrate** | No OCX timer; native seal is not a config restore; `/var/lib/chef/backups` is other products. Any schema or path migration without a new backup is stop-the-line. |
| Release SHA ≠ tested SHA | **OPEN** | main `4a589932` (1.2.2) ≠ prod `71c3cad1` (1.2.1) ≠ npm 1.2.1. No `v1.2.2` tag. deploy.yml has never run, so **no SHA has a deploy-test record**. |
| GUI requires undocumented backend behavior | **OPEN / residual** | GUI is a same-origin SPA; `/api/*` requires admin token; CF Access JWT can mint GUI session (`cf-access-auth.ts`). Hand-built bundle is not the tag’s tree. Cannot certify GUI↔API contract without an authenticated session (not performed). |
| Provider state can silently disappear | **OPEN** | Unversioned JSON, last `usage.jsonl` write 2026-08-22 10:07, no backup. A bad write or a deploy that changes `HOME`/`WorkingDirectory` loses the store. |
| Secret appears in logs | **CLEAR in last 200 journal lines** | Pattern scan zero. Does not prove older rotated journals or future verbose flags. |
| Production checkout dirty | **CLEAR for git; OPEN for dist** | Porcelain empty; served GUI is an ignored tree. deploy.yml “refuse dirty” would **not** see `gui/dist` and **would overwrite it** on the next `build:gui` — if that build is pointed at the runtime path and if Node can build. |
| Health passes while primary API fails | **STRUCTURAL RISK, not currently observed as a silent split** | `/healthz` 200 without auth. `/v1/models` 401 without key (correct). Unauthenticated 401 is **not** “API down.” What **is** true: deploy.yml treats `healthz` `"status":"ok"` as success and **never** calls `/v1/models`. Combined with V2, today’s workflow would not reach a green health on this host at all; if V2 were patched in isolation, a dead data-plane could still look green. |
| Rollback untested | **OPEN — stop-the-line for any first use of deploy.yml** | `total_count: 0`. The rollback step (`if: failure() && …`) has never executed. It rolls back **DEPLOY_PATH** (psp, not runtime) and then health-gates loopback — so a “successful” rollback on main’s workflow would (a) mutate the unused tree, (b) restart the real service, (c) fail the loopback gate, (d) leave runtime at whatever SHA it already was. **First-ever deploy is not a rollback rehearsal; it is an unknown.** |

**Risk reading of “deploy.yml has never run”:** this is not a dormant safe switch. It is an untested script that points at the wrong tree and the wrong health address, with a rollback clause that inherits both bugs. Enabling it on main as-is is more dangerous than leaving production on the hand-pinned 1.2.1 tree.

---

## 5. Snapshot claims that are stale or wrong (short list)

1. **`git.dev_sha: 778470d6` — REFUTED.** Live `origin/dev` is `07bc1f60`. Five commits (including az-01 deploy retarget) are invisible if lanes trust the snapshot SHA.
2. **`ingress_mechanism: UNKNOWN` — understated.** Mechanism is Cloudflare Access + tunnel `27f2c693` via **bc-scan-2** to `100.109.39.86:10100`. “Unknown on az-01” is the accurate local observation; it is the wrong programme premise.
3. **`remote_branch_count: 20`** counts `origin/HEAD`. 19 branches.
4. **`latest_tag: v1.2.1`** is product-line latest, not repo-semver latest (`v2.7.33` exists).
5. **`secrets_location` “16+ keys”** — 11 `*_API_KEY` names in the live process; file unread.
6. **`backups_on_host` “20K”** — 2831 bytes / 16K `du`.
7. **`runtime_dirty: false`** is git-true and operationally incomplete (ignored `gui/dist`).
8. **`healthz` body** omitted `uptime`/`pid`.
9. **`/var/lib/chef/{backups,rollback}`** now known: not OCX.
10. **`origin/dev` already remediates V1/V2/V5** — Wave 0 described main-only truth without saying the fix is already on dev.

---

## 6. Constraints honoured

- No implementation, refactor, or production mutation (no restart, no write, no merge, no push, no tag, no PR).
- `sudo journalctl` and `ss`/`git` on az-01 were **read-only** inspections required by this mission; unit state was not changed.
- `/home/jan/opencodex` was read with git porcelain only.
- Secret values were not printed. `service.env` was not catted. Journal/GUI/API scans report class and location only.
- This lane wrote only `docs/convergence/*`.
