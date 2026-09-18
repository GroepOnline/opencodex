# OpenCodex devcontainer

Coding environment for the same proxy/app path used in production: port `10100`,
identity-checked `GET /healthz`.

## What this is

- **This folder** installs Bun 1.4.0 and runs `bun install` so you can hack on
  `src/` and `gui/` (`bun run start`, `bun run test`).
- **Repo-root `compose.yml`** is the local stand-in for
  `deploy/container/compose.example.yml` + `opencodex-proxy.service`. It builds
  the first-party image and publishes `127.0.0.1:10100`.

Open the folder in a Dev Container, or run the compose path from a host that
has Docker. Operator notes, the live pin, and Authentik placeholders
(`chefgroep-ocx-oidc`; issuer APPLY DONE 2026-09-18) live in
[`deploy/container/README.md`](../deploy/container/README.md).

## After create

```bash
# source path (inside the container)
bun run start
bash scripts/healthz-smoke.sh

# compose path (Docker on the host or a sibling compose project)
cp .env.example .env
mkdir -p deploy/container/.secrets .tmp/opencodex-state
umask 077 && python3 -c 'import secrets; print(secrets.token_hex(16))' > deploy/container/.secrets/api-token
docker compose up -d --build
bash scripts/healthz-smoke.sh
```

`scripts/healthz-smoke.sh` probes `http://127.0.0.1:10100/healthz` with the same
identity fields the live health gate uses (`status`, `service`, `pid`, `port`,
`gitSha`, `version`).
