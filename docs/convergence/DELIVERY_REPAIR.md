# Delivery repair — Lane E (OCX 3.0 convergence)

Wave 0 ground truth: `evidence/OCX_STATE_SNAPSHOT.yaml`. This document records root causes,
fixes, gating design, release-path coherence, Deployment v2 (later), PR #90 relationship,
and the safe first-deploy procedure.

## Root-cause table

| ID | Invariant | Finding | Fix |
| --- | --- | --- | --- |
| **V1** | Runtime authority | `deploy.yml` updated `/home/chef/opencodex-psp` but systemd runs `/opt/chef/services/opencodex`. A “successful” deploy changed nothing that runs. | `DEPLOY_PATH` → `/opt/chef/services/opencodex`. Post-deploy checkout SHA is verified against the pinned tag SHA. |
| **V2** | Observability authority | Health gate probed `http://127.0.0.1:10100/healthz` but the proxy binds only the configured Tailscale hostname (`100.109.39.86:10100`). Loopback is refused; gate could never pass. | `Resolve health URLs` reads `~/.opencodex/config.json` (`hostname`, `port`) as the primary probe target, with loopback and discovered Tailscale IPv4 as fallbacks. No hardcoded addresses. |
| **V3** | Release authority | `main` carries `release: v1.2.2` + `package.json` 1.2.2 but no `v1.2.2` tag exists. npm and production sit on v1.2.1. Deploy workflow has zero runs. | Release path documented below. Recommendation: tag `v1.2.2` on the existing release commit (do not create the tag during convergence freeze). |
| **V5** | Runtime authority | Workflow header, concurrency group, and docs named retired `chef-control-01`. Real host is `chef-control-az-01`; runner `ocx-deploy-az-01`. | Renamed workflow to `Deploy to chef-control-az-01`, concurrency `ocx-deploy-az-01`, updated `publish-on-tag.yml` cross-references. |
| **V6** | Release authority | Host Node v18.19.1; Vite needs ≥20.19 \|\| ≥22.12. `build:gui` failed on deploy host; GUI was manually rebuilt. | `actions/setup-node` pins Node **22.12.0** before `bun run build:gui`. |

## What changed (by file)

### `.github/workflows/deploy.yml`

- **Absorbs and supersedes PR #90** (Node 22.12.0 pin, dashboard HTML gate) on top of the `origin/dev` az-01 path/runner fixes.
- Correct runtime checkout path (`/opt/chef/services/opencodex`).
- Config-driven health/base URL resolution (V2).
- `actions: read` + **Cross-platform CI gate** on the pinned tag SHA (aligned with `publish-on-tag.yml`).
- **Four-level post-restart gates** (L1–L4) with rollback re-verifying L2 + GUI.
- Preserved guards: dispatch ref via env (not inline `${{ }}`), tag shape, origin/main ancestry, pinned tag SHA checkout, dirty-tree refusal, live-only commit refusal, rollback only after successful deploy step.

### `.github/workflows/publish-on-tag.yml`

- References updated from `chef-control-01` / `Deploy to control-01` → `chef-control-az-01` / `Deploy to chef-control-az-01`.

### `tests/ci-workflows.test.ts`

- Renamed `control-01` deploy tests → `az-01`.
- Pins: correct `DEPLOY_PATH`, config-based URL resolution, Node 22.12.0, CI gate permission, L1–L4 step IDs and contracts, PR #90 dashboard title assertions, preserved rollback guards.

### `RELEASE_PROCESS.md`

- Added “Live deploy path” section documenting tag → publish → deploy coherence.

## Relationship to PR #90

| Aspect | PR #90 (`fix/azure-gui-deploy-lane` → `dev`) | This lane |
| --- | --- | --- |
| Node 22.12.0 for Vite | Yes | **Absorbed** |
| Dashboard `<title>` gate in health/rollback | Yes | **Absorbed** into L4 + rollback |
| Correct `DEPLOY_PATH` / az-01 naming | Already on `dev`, not in PR #90 diff | **Included** (from `origin/dev`) |
| Config-driven health URLs | On `dev` (Tailscale discovery) | **Extended** — primary probe from `config.json` hostname |
| L1–L4 gates, CI gate on deploy | No | **New in this lane** |
| Base branch | `dev` | `main` via convergence worktree |

**Verdict:** This work **supersedes PR #90** for merge purposes. When `#90` lands on `dev`, merge/rebase should prefer this branch’s `deploy.yml` and test pins — they are a strict superset. No contradictory paths remain.

## Four-level health gate specification

### L1 — Process

- **Checks:** `systemctl is-active opencodex-proxy.service`; `MainPID` is a positive integer.
- **Implemented:** `L1 process gate` step.
- **Backend support:** None required.

### L2 — Service

- **Checks:** Identity-verified `GET /healthz` — `status=ok`, `service=opencodex`, `pid` matches systemd `MainPID`, `version` matches deploy tag (without `v` prefix). Probes all resolved health URLs within a 60s deadline.
- **Implemented:** `L2 service health gate` step; records working `base_url` for L3/L4.
- **Backend support:** None required (`/healthz` already exposes `pid` and `version`).

### L3 — Dependencies

- **Checks:** `~/.opencodex/config.json` exists (pre-deploy); authenticated `GET /api/startup-health` reports `serviceRunning: true`; authenticated `GET /api/providers` returns a non-empty list (config persistence + management plane reachable).
- **Implemented:** `L3 dependencies gate` step using `~/.opencodex/admin-api-token`.
- **Backend support:** None required today. Optional future: dedicated `GET /api/deploy/readiness` returning structured dependency status (config readable, provider count, persistence writable) so the workflow does not scrape multiple endpoints.

### L4 — Product

- **Checks implemented:**
  - Dashboard HTML contains `<title>opencodex · proxy dashboard</title>` and bundled `src="/assets/` references (proves Vite build is served, not JSON fallback).
  - Authenticated `GET /api/config` + deployed `package.json` version matches tag.
  - Data-plane `GET /v1/models` with first configured `apiKeys[].key` (skipped with warning if no key configured).
- **Not implemented (needs Lane G):**
  - **Provider upstream smoke** via `POST /api/providers/test?name=<defaultProvider>` as a deploy gate — hits live upstream and can flake on provider outages; not wired as a hard gate.
  - **Browser-level smoke** (Playwright/headless) — workflow uses HTML content probes only; cannot execute JS or verify React hydration.
  - **Requested Lane G contract:** `GET /api/deploy/smoke` (management-auth) returning `{ ok, version, gui: { built, title }, providers: { count, defaultReachable }, models: { count } }` with bounded upstream probes and explicit `skipReason` fields — single round-trip for L3+L4.

## Release path (main → npm → production)

```
main (clean, CI green)
  │
  ├─ bun scripts/release.ts <version> [--publish]
  │     → bump package.json, commit release: vX.Y.Z, push
  │     → wait Cross-platform CI + Service lifecycle on release SHA
  │     → dispatch release.yml (OIDC npm publish, creates vX.Y.Z tag + GitHub Release)
  │
  └─ OR: git tag vX.Y.Z && git push origin vX.Y.Z   (tag must sit on origin/main)
        ├─ publish-on-tag.yml  → npm publish + GitHub Release (requires CI success on tag SHA)
        └─ deploy.yml          → live rollout on ocx-deploy-az-01 (requires CI success on tag SHA)
```

**Preview vs stable**

| Channel | Version shape | npm dist-tag | GitHub Release | Deploy |
| --- | --- | --- | --- | --- |
| Stable | `X.Y.Z` | `latest` | normal | yes |
| Preview | `X.Y.Z-preview.N` | `preview` | `--prerelease` | yes (same tag trigger) |

Both `publish-on-tag.yml` and `deploy.yml` trigger on `v*.*.*` tag push and require the tagged commit to be on `origin/main` with a successful Cross-platform CI run.

### v1.2.2 reconciliation (recommendation — do not tag during freeze)

**Recommend: tag `v1.2.2` on the existing release commit `6271c7c9` (`release: v1.2.2`).**

Reasoning:

- That commit is the deliberate release bump; `package.json` already reads `1.2.2`.
- Creating `v1.2.2` on current `main` (`4a589932`) would require either moving the release commit or accepting a tag/ package.json mismatch.
- Only one commit (`4a589932`, docs-only) sits after the release commit; it can ship as `v1.2.3` later.
- Bumping to `v1.2.3` now without re-running the release helper would orphan the `release: v1.2.2` commit’s intent.

**Before tagging:** run Cross-platform CI on `6271c7c9` (or merge docs fix first and re-evaluate if docs must be in the release).

## Deployment v2 design (later wave — does not block recovery)

**Goal:** Remove in-place git checkout + on-host build from production.

```
/opt/opencodex/releases/<version>/     # immutable artifact tree (pre-built gui/dist, node_modules or bundled)
/opt/opencodex/current → releases/X.Y.Z/   # symlink
systemd ExecStart=bun /opt/opencodex/current/src/cli/index.ts start ...
```

**Migration path from today:**

1. **Wave 1 (this lane):** Fix in-place deploy so the path systemd uses is what the workflow updates; gates prove the service actually changed.
2. **Wave 2:** CI builds release artifact (GUI included); upload as GitHub Release asset or internal registry; deploy job downloads + extracts to `releases/<version>`, repoints `current`, restarts.
3. **Wave 3:** systemd unit change — `WorkingDirectory=/opt/opencodex/current`, drop git/fetch from deploy job; rollback = repoint symlink to previous release + restart + L1–L4.
4. **Wave 4:** Retire `/home/chef/opencodex-psp` and legacy checkouts under `/opt/chef/services/.opencodex-backup-*`.

**Why later:** Production has never had a successful automated deploy; fixing path/gates/Node on the existing model is lower risk than simultaneous artifact-model + unit migration.

## Safe first-deploy procedure

Deploy workflow has **zero historical runs**. First execution is high risk.

### Pre-flight (human, read-only on production)

1. `ssh chef-control-az-01`
2. Confirm systemd: `systemctl status opencodex-proxy.service` — active, `WorkingDirectory=/opt/chef/services/opencodex`.
3. Confirm runtime path is a git checkout: `cd /opt/chef/services/opencodex && git rev-parse HEAD` — expect `71c3cad1` (v1.2.1).
4. Confirm clean tree: `git status --porcelain` — must be empty.
5. Confirm bind address: `python3 -c "import json; c=json.load(open('/home/chef/.opencodex/config.json')); print(c['hostname'], c.get('port',10100))"` — expect Tailscale IP, not loopback-only.
6. Confirm health via configured hostname: `curl -fsS "http://<hostname>:10100/healthz"`.
7. Confirm runner online: GitHub → Settings → Actions → Runners → `ocx-deploy-az-01`.
8. Confirm host Node after workflow starts (Actions log): setup-node must report 22.12.0 before `build:gui`.

### Execute (after freeze lifts)

1. Ensure `v1.2.2` tag exists on `6271c7c9` (or chosen release SHA) and Cross-platform CI is green on that SHA.
2. Prefer **`workflow_dispatch`** with `ref: v1.2.2` first (not a fresh tag push) so publish and deploy can be observed separately.
3. Watch Actions → **Deploy to chef-control-az-01**; do not restart services manually during the run.

### Abort

- **During workflow:** Cancel the GitHub Actions run. If cancel lands after checkout/build but before rollback, manually verify service health and be prepared to run rollback logic: checkout previous SHA `71c3cad1` in `/opt/chef/services/opencodex`, `bun install && bun run build:gui` (with Node ≥22), `sudo systemctl restart opencodex-proxy.service`.
- **If workflow fails and rollback step runs:** Confirm rollback step completed; verify health via Tailscale IP.
- **If workflow fails and rollback does not run** (failure before deploy step): Production is unchanged — no action required.

### Post-deploy verification

1. `curl healthz` shows new `version` and new `pid`.
2. Dashboard loads at `http://<hostname>:10100/` with real HTML (not JSON `"dashboard":{"available":false}`).
3. `cd /opt/chef/services/opencodex && git rev-parse HEAD` matches tag SHA.

### Risks

| Risk | Mitigation |
| --- | --- |
| First GUI build on runner fails | Node 22.12.0 pin; dry-run `bun run build:gui` on host before dispatch |
| L3/L4 fail on missing admin token | Verify `~/.opencodex/admin-api-token` exists |
| `/v1/models` smoke fails | Ensure at least one valid `apiKeys` entry; or accept warning-only skip |
| Extended outage during restart | Deploy during low traffic; rollback step auto-restores prior SHA |
| Tag push triggers publish + deploy simultaneously | Use `workflow_dispatch` for first deploy |

## Human verification checklist (before first real deploy)

- [ ] `DEPLOY_PATH` on host matches `/opt/chef/services/opencodex`
- [ ] Live checkout clean and at ancestor of target tag SHA
- [ ] Target tag exists on remote and sits on `origin/main`
- [ ] Cross-platform CI green on tag SHA
- [ ] `admin-api-token` present
- [ ] `config.json` hostname resolves on host (curl healthz)
- [ ] Runner `ocx-deploy-az-01` online
- [ ] Rollback SHA `71c3cad1` documented
- [ ] Freeze lifted; stakeholder aware this is the first ever deploy run
