# OpenCodex container + systemd path

This directory contains generic deployment examples for the OpenCodex proxy.
It deliberately does not describe any ChefGroep production host, private
network address, release-tree path, credential location or live cutover state.

| Path                                                               | Role                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| [`compose.example.yml`](./compose.example.yml)                     | Digest-pinned Compose reference.                      |
| [`opencodex-proxy.service`](./opencodex-proxy.service)             | Example systemd wrapper for the Compose deployment.   |
| [`../../compose.yml`](../../compose.yml)                           | Local/dev Compose using this repository's Dockerfile. |
| [`../../.env.example`](../../.env.example)                         | Secret-free environment template.                     |
| [`model-catalog.example.json`](./model-catalog.example.json)       | Generic, key-free provider catalog example.           |
| [`../oidc/CUTOVER-CHECKLIST.md`](../oidc/CUTOVER-CHECKLIST.md)     | Generic OIDC cutover checklist.                       |
| [`../../scripts/healthz-smoke.sh`](../../scripts/healthz-smoke.sh) | `/healthz` identity smoke.                            |

## Local/dev

```bash
cp .env.example .env
mkdir -p deploy/container/.secrets .tmp/opencodex-state
umask 077
python3 -c 'import secrets; print(secrets.token_hex(16))' > deploy/container/.secrets/api-token
docker compose up -d --build
bash scripts/healthz-smoke.sh
```

Source-only:

```bash
bun install --frozen-lockfile
bun run start
bash scripts/healthz-smoke.sh
```

Without GitHub Actions, `bash scripts/local-runtime.sh up` starts this compose
file when Docker is available, or applies [`../k3s/opencodex.yaml`](../k3s/opencodex.yaml)
when k3s is available. `bash scripts/local-runtime.sh check` runs the local
typecheck and the loopback `/healthz` identity check. See
[`../k3s/README.md`](../k3s/README.md).

ClickHouse for local telemetry is opt-in:

```bash
OPENCODEX_WITH_CLICKHOUSE=1 bash scripts/local-runtime.sh up
```

`scripts/healthz-smoke.sh` defaults to
`http://127.0.0.1:10100/healthz` and requires `status=ok`,
`service=opencodex`, numeric `pid`/`port`, and a non-empty `gitSha`.
Use `OPENCODEX_SMOKE_EXPECT_SHA` and
`OPENCODEX_SMOKE_EXPECT_VERSION` when a deployment gate must bind an exact
artifact.

## Persistent Claude Desktop library

The container stores its applied Claude Desktop 3P library under
`/var/lib/opencodex/claude-desktop`, inside the existing persistent
`OPENCODEX_STATE_DIR` mount. Keep
`OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR=/var/lib/opencodex/claude-desktop` in
container deployments. Otherwise a profile applied through the management API
is lost or hidden when the container is recreated, and remote Desktop clients
receive `404` from `/v1/claude-desktop-3p-library`.

## Authentication

Remote data-plane binds must use a generated client admission key or the
service-token mechanism described by the product. Do not distribute a host
service credential to clients.

OIDC deployments provide issuer, client-id, redirect and client-secret-file
settings through the deployment environment. Client secrets never belong in
source control. See [the generic cutover checklist](../oidc/CUTOVER-CHECKLIST.md).

## Production boundary

Publishing a package or image does not deploy a production runtime. Production
host placement, private addresses, release paths, credentials, current version
and rollback evidence belong to the operator's private deployment repository or
configuration system.

The gated GHCR image publication supports `linux/amd64` and `linux/arm64`. The
pull-request image check remains a single-platform `linux/amd64` build and does
not publish an image.

The public repository intentionally fails closed instead of carrying a live
ChefGroep deployment target.
