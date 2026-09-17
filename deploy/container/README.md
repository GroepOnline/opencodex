# OpenCodex container + systemd path

This directory is the production compose/unit contract. Local/dev uses the same
proxy/app path (`:10100/healthz`) without touching the live place lock.

| Path                                                                                             | Role                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`compose.example.yml`](./compose.example.yml)                                                   | Production Compose. Digest-pinned image, loopback + Tailscale `:10100`. Copied to `/opt/chef/deploy/opencodex/docker-compose.yml` on tag deploy. |
| [`opencodex-proxy.service`](./opencodex-proxy.service)                                           | systemd oneshot that runs `docker compose up/down` in that directory.                                                                            |
| [`../../compose.yml`](../../compose.yml)                                                         | Local/dev Compose. Builds from this repo's `Dockerfile`, loopback `:10100` only.                                                                 |
| [`../../.env.example`](../../.env.example)                                                       | Env template. No secrets.                                                                                                                        |
| [`../../.devcontainer/`](../../.devcontainer/)                                                   | Coding container (Bun 1.4.0).                                                                                                                    |
| [`../oidc/authentik-ocx-client.placeholder.json`](../oidc/authentik-ocx-client.placeholder.json) | Authentik OIDC client contract (greenfield).                                                                                                     |
| [`../../scripts/healthz-smoke.sh`](../../scripts/healthz-smoke.sh)                               | Local/dev `/healthz` identity smoke matching `:10100/healthz`.                                                                                   |

## Live place lock

Do **not** retarget, redeploy, or rewrite the live pin from this repository
change. Reported live identity:

| Field      | Value                                                                |
| ---------- | -------------------------------------------------------------------- |
| Unit       | `opencodex-proxy.service`                                            |
| Version    | `1.4.2`                                                              |
| Source SHA | `529bb6a9c0ab2650f883e88c9373002ed1eb14f7` (tag `v1.4.2`)            |
| Health     | `GET /healthz` on loopback and the host Tailscale IPv4, port `10100` |

The immutable GHCR digest is stored only on the live host as `OPENCODEX_IMAGE`
in `/opt/chef/deploy/opencodex/.env`. This unit file does not embed a version.
`.github/workflows/deploy.yml` still names `chef-control-az-01`; reconciling
that runner label with a later host is out of scope here.

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

## Authentik OIDC placeholders

ChefGroep Auth / Authentik is still greenfield. The placeholder file lists
redirect URIs for local loopback and `https://ocx.chefgroep.online`. Compose
forwards `OIDC_*` when set. The proxy does **not** verify Authentik tokens yet;
Cloudflare Access remains the live public-host dashboard gate.

- Do not put a client secret in git. Use `OIDC_CLIENT_SECRET_FILE`.
- Do not register this client in ChefFactory catalogs (Factory owns catalog).
- Do not apply Cloudflare DNS from this repository.

## Honest blockers

1. Authentik product gate is greenfield: no live issuer/client secret, no
   runtime OIDC verifier.
2. This change documents the `1.4.2` / `529bb6a9` pin and does not move it.
3. `deploy.yml` still targets the az-01 deploy runner; do not treat a merge
   here as a live cutover.
4. Public `ocx.chefgroep.online` Cloudflare is already applied; this repo does
   not mutate DNS.
