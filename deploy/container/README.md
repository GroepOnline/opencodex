# OpenCodex container + systemd path

This directory is the production compose/unit contract. Local/dev uses the same
proxy/app path (`:10100/healthz`) without touching the live place lock.

| Path                                                                                             | Role                                                                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [`compose.example.yml`](./compose.example.yml)                                                   | Digest-pinned Compose reference for `opencodex-proxy.service`; not the live bc-scan-2 deployment. |
| [`opencodex-proxy.service`](./opencodex-proxy.service)                                           | Non-serving systemd oneshot that runs `docker compose up/down` in that directory.                 |
| [`../../compose.yml`](../../compose.yml)                                                         | Local/dev Compose. Builds from this repo's `Dockerfile`, loopback `:10100` only.                  |
| [`../../.env.example`](../../.env.example)                                                       | Env template. No secrets.                                                                         |
| [`../../.devcontainer/`](../../.devcontainer/)                                                   | Coding container (Bun 1.4.0).                                                                     |
| [`../oidc/authentik-ocx-client.placeholder.json`](../oidc/authentik-ocx-client.placeholder.json) | Authentik OIDC client contract (`chefgroep-ocx-oidc`; issuer APPLY DONE 2026-09-18).              |
| [`../oidc/CUTOVER-CHECKLIST.md`](../oidc/CUTOVER-CHECKLIST.md)                                   | Authorize canary and CoS / Cloudflare Access cutover checklist.                                   |
| [`../../scripts/oidc-authorize-canary.sh`](../../scripts/oidc-authorize-canary.sh)               | Secret-free discovery/JWKS (and optional `/oauth/login`) canary.                                  |
| [`../../scripts/healthz-smoke.sh`](../../scripts/healthz-smoke.sh)                               | Local/dev `/healthz` identity smoke matching `:10100/healthz`.                                    |

## Live place lock

Do **not** retarget, redeploy, or rewrite the live pin from this repository
change. Reported live identity:

| Field      | Value                                                     |
| ---------- | --------------------------------------------------------- |
| Unit       | `opencodex-proxy.service`                                 |
| Unit state | Non-serving; a separate npm process owns port `10100`     |
| Version    | `1.5.0`                                                   |
| Source SHA | `f5cc348b7f0b7a48a9241cac17714399c2777c0f` (tag `v1.5.0`) |
| Health     | `GET /healthz` on the host Tailscale IPv4, port `10100`   |

The live bc-scan-2 service runs the published npm package from
`/home/joep/.opencodex/releases/current`; this unit file does not embed a
version and is not the live process owner. Do not restart it until the npm
package procedure is documented or the unit is reconciled. `.github/workflows/deploy.yml`
is retired fail-closed and no longer retargets or rolls back any host. A
source-owned bc-scan-2 package deployment contract remains a separate operation.

## Local/dev (complete proxy/app path)

```bash
cp .env.example .env
mkdir -p deploy/container/.secrets .tmp/opencodex-state
umask 077
python3 -c 'import secrets; print(secrets.token_hex(16))' > deploy/container/.secrets/api-token
docker compose up -d --build
bash scripts/healthz-smoke.sh
```

Source-only (no Docker), same health contract:

```bash
bun install --frozen-lockfile
bun run start
bash scripts/healthz-smoke.sh
```

`scripts/healthz-smoke.sh` defaults to `http://127.0.0.1:10100/healthz` and
requires `status=ok`, `service=opencodex`, numeric `pid`/`port`, and a non-empty
`gitSha`. Set `OPENCODEX_SMOKE_EXPECT_SHA` / `OPENCODEX_SMOKE_EXPECT_VERSION` to
bind those fields the way the production health gate binds the release tag.

## Authentik OIDC consumer

Public ChefGroep Auth issuer is **APPLY DONE 2026-09-18** at
`https://auth.chefgroep.online/application/o/ocx/` (discovery/JWKS 200,
authorize 302). The issuer is **not** DNS HOLD. Live `client_id` is
`chefgroep-ocx-oidc` (Infra smoke + Cloudflare Access IdP). `client_secret`
stays `null` / file-only (`OIDC_CLIENT_SECRET_FILE`).

The consumer contract lists redirect URIs for local loopback and
`https://ocx.chefgroep.online`. Compose forwards `OIDC_*` when set. The proxy
verifies Authentik ID tokens (JWKS) and runs `GET /oauth/login` →
`/oauth/callback` (authorization-code + PKCE) when the secret file is present.
**Cloudflare Access remains the live public-host dashboard gate** until
operators execute [`../oidc/CUTOVER-CHECKLIST.md`](../oidc/CUTOVER-CHECKLIST.md).

- Do not put a client secret in git. Use `OIDC_CLIENT_SECRET_FILE`.
- Do not register this client in ChefFactory catalogs (Factory owns catalog).
- Do not apply Cloudflare DNS from this repository.

```bash
bash scripts/oidc-authorize-canary.sh
# optional, against a running local proxy with OIDC_* set:
OPENCODEX_OIDC_CANARY_URL=http://127.0.0.1:10100 bash scripts/oidc-authorize-canary.sh
```

## Fleet model catalog

Runtime providers are not part of the image pin. The key-free default is
[`model-catalog.example.json`](./model-catalog.example.json), described in
[`../../docs/models.md`](../../docs/models.md).

| Check     | Rule                                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Providers | `azure-us` (`openaichef`, eastus), `azure-se` (`openaichef-se`, swedencentral), `azure-foundry-us` (`azure-foundry-us`, eastus)                                                                |
| Wire      | `openai-chat` against `https://<resource>.cognitiveservices.azure.com/openai/v1`                                                                                                               |
| Keys      | Host env only: `AZURE_OPENAI_KEY_OPENAICHEF`, `AZURE_OPENAI_KEY_OPENAICHEF_SE`, `AZURE_OPENAI_KEY_AZURE_FOUNDRY_US`. Never commit values.                                                      |
| Removed   | `jort-7512-resource`, AWS/Bedrock hosts, `chef-control-az-01` as a model upstream, stopped llama.cpp/weg54 inference                                                                           |
| Apply     | Edit the host `~/.opencodex/config.json`, keep mode `0600`, then defer restart until the npm procedure is documented or the unit is reconciled. Do not retarget the binary pin from this file. |
| Check     | `ocx config validate` before restart. `GET /v1/models` on the bind address must list `azure-us/*`, `azure-se/*`, and `azure-foundry-us/fw-deepseek-v4-pro`.                                    |

Copying the example over a live file drops every other provider. Merge it into
the existing `providers` map instead.

## Honest blockers

1. Authentik issuer public apply is done (2026-09-18). The consumer is wired,
   but Cloudflare Access remains the live public-host gate until the cutover
   checklist is executed. Client secret is not in git.
2. This change documents the `1.5.0` / `f5cc348b7` live release and does not
   move it. Do not deploy this PR to bc-scan-2.
3. The former Azure `deploy.yml` route is retired fail-closed; do not treat a
   merge here as a live cutover.
4. Public `ocx.chefgroep.online` Cloudflare is already applied; this repo does
   not mutate DNS or ChefFactory catalogs.
