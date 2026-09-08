# OCX management API contracts — Lane G

Branch: `convergence/lane-g-contracts` · Base: `origin/main` @ `4a589932`  
Contract version: `1.0.0` (`src/server/contract-version.ts`)

The GUI is a visualization of these contracts. A view that requires an undocumented
backend field is a stop-the-line condition.

## Versioning

- Header-free contract id: `MANAGEMENT_CONTRACT_VERSION` in every provenance and
  health response as `contract_version`.
- Bump the semver when a response shape used by the GUI or deploy gate breaks.
- Additive fields are allowed without a bump; removals and type changes are not.

## Provenance

`GET /api/provenance` is deploy-gate friendly.

| Caller | Auth | Body |
|---|---|---|
| Deploy L3 / unauthenticated | none | `{ contract_version, version, git_sha, built_at, release, schema_version, gui_version, runtime }` |
| Management / GUI footer | management token | public body + `management { hostname, default_provider, provider_count, management_auth_available }` |

`schema_version` is `null` when the store has no `schema_version` / `schemaVersion`
(Lane C introduces the field). `git_sha` / `built_at` / `release` come from
`src/build-info.json`, written by `scripts/generate-build-info.ts` during
`prepare-package`. Local `bun start` and npm consumers without git get `null`s —
that is valid, not a crash.

No secrets, no provider keys, no account ids.

## Health contract

`GET /api/health` requires management auth. Shape:

```json
{
  "status": "ok | degraded | down | unknown",
  "checked_at": "ISO-8601",
  "contract_version": "1.0.0",
  "components": {
    "proxy": { "status": "ok", "since": null, "message": "…" },
    "management_api": { "status": "ok", "since": null, "message": "…" },
    "persistence": { "status": "ok", "since": null, "message": "…" },
    "providers": [{ "name": "…", "disabled": false, "status": "ok", "since": null, "message": "…" }],
    "deploy_runner": { "status": "unknown", "since": null, "message": "out-of-process" }
  },
  "causality": [{ "component": "provider:x", "status": "degraded", "since": null, "reason": "…", "depends_on": ["persistence"] }]
}
```

`/healthz` stays the L2 process probe. This endpoint is L3/L4 + the GUI Health view.

`deploy_runner` is `unknown` by design: the runner lives in a different systemd unit.
Lane E must not treat that as a hard deploy failure.

## Capability matrix

| Domain | Read | Create | Update | Delete | Test | Health |
|---|---|---|---|---|---|---|
| Providers | EXISTS `GET /api/providers` | EXISTS `POST /api/providers` | EXISTS `PATCH /api/providers` | EXISTS `DELETE /api/providers` | EXISTS `POST /api/providers/test` | PARTIAL `GET /api/provider-quotas` |
| Accounts (Codex) | EXISTS `GET /api/codex-auth/accounts` | PARTIAL guarded import | EXISTS switch / disable | EXISTS remove | MISSING dedicated test | PARTIAL quota + login-status |
| OAuth accounts | EXISTS `GET /api/oauth/accounts` | EXISTS login start | EXISTS switch / pool | EXISTS remove | MISSING dedicated test | PARTIAL login-status |
| Pools | EXISTS pool-strategy / auto-switch | n.v.t. | EXISTS strategy PATCH | n.v.t. | MISSING dedicated probe | PARTIAL quotas |
| Models | EXISTS `GET /api/models` | — | EXISTS visibility / disabled-models | — | PARTIAL models/refresh | PARTIAL provider-quotas |
| Usage | EXISTS `GET /api/usage` | — | — | — | — | PARTIAL via `/api/health` persistence |
| Requests | EXISTS `GET /api/logs` | — | — | — | MISSING replay | PARTIAL via `/api/health` |
| Runtime | EXISTS `/api/config` `/api/provenance` | — | EXISTS `PUT /api/settings` | — | PARTIAL `/api/startup-health` | EXISTS `/api/health` + `/healthz` |

EXISTS cells have a live integration test in `tests/management-contract.test.ts`.
MISSING cells are `test.skip` placeholders so the gap stays visible in CI.

## GUI ↔ backend gaps

### GUI calls something the backend does not provide

None found as a hard 404. The stop-the-line condition is **not** currently tripped
on `origin/main`. Soft gaps:

- Account / OAuth “Test” in the IA is a login-status poll, not `POST …/test`.
- Health view today is `/api/startup-health` + per-provider quotas, not `/api/health`.
  Lane D must switch to this contract; do not invent a third shape.

### Backend capability the GUI never uses

- `POST /api/providers/test`
- `GET /api/provider-quotas` (partial)
- Codex failover / quota write endpoints
- `PUT /api/disabled-models` (catalog workspace uses model-visibility instead)
- Combo CRUD
- `/api/update` / sidecar settings (system routes)

## What other lanes must know

- Lane E: gate L3 on `GET /api/provenance` (no auth) + `GET /api/startup-health`
  (auth). Prefer `GET /api/health` for L3 once this branch is on main. Do not
  invent `GET /api/deploy/readiness` — this is that contract.
- Lane B: health cannot yet say RATE_LIMITED / COOLDOWN / AUTH_FAILED. Those
  states are process-local (V13). This contract reports configured/disabled/
  missing-credentials only.
- Lane C: `schema_version` is read if present, otherwise `null`. Safe default.
- Lane D: Overview/Health consume `/api/health` + `/api/usage` + `/api/logs`.
  Usage has no account field and is 83% synthetic on live (V12) — the empty /
  insufficient-data state is required.
