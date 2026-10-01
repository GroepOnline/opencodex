---
title: Edge Access vs OIDC
description: How OpenCodex can combine an outer access gateway with product-level OIDC.
---

OpenCodex can use an outer access gateway and product-level OIDC for the
human dashboard. These are separate trust boundaries.

| Gate | What the proxy checks | Typical use |
| --- | --- | --- |
| **Cloudflare Access (edge gateway example)** | `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` JWT (`cf-access-jwt-assertion` or `CF_Authorization`) | Optional Cloudflare-specific outer browser gate during migration or defense in depth |
| **Product OIDC** | Configured issuer/client, JWKS ID-token verification, `GET /oauth/login` → flow cookie → `/oauth/callback` | Browser identity enforced directly by OpenCodex |
| **Admin token / GUI session** | `OPENCODEX_ADMIN_AUTH_TOKEN` or loopback-minted session | Local/admin management access |
| **Service API token / client key** | OpenCodex data-plane admission credential | `/v1/*` only |

On deployments that require data-plane authentication, an OIDC browser
session does not admit `/v1/*` by itself. Loopback deployments may admit
`/v1/*` without an additional data-plane credential. Edge-gateway and OIDC
configuration must not silently widen data-plane admission.

`GET /healthz` remains governed by the deployment's health policy and should
not depend on browser login.

## Environment

Copy [`.env.example`](https://github.com/GroepOnline/opencodex/blob/main/.env.example).
Never set `OIDC_CLIENT_SECRET` directly in the environment or commit it.

```bash
OIDC_ISSUER=https://id.example.com/application/o/opencodex/
OIDC_CLIENT_ID=opencodex
OIDC_CLIENT_SECRET_FILE=/path/to/oidc-client-secret
OIDC_REDIRECT_URI=http://127.0.0.1:10100/oauth/callback
OIDC_ALLOWED_HOSTS=opencodex.example.com
```

Token verification needs issuer + client ID. The browser authorization flow
also needs the secret file and a redirect URI registered by the deployment
owner.

## Canary

```bash
export OIDC_ISSUER=https://id.example.com/application/o/opencodex/
export OIDC_CLIENT_ID=opencodex
bash scripts/oidc-authorize-canary.sh
OPENCODEX_OIDC_CANARY_URL=http://127.0.0.1:10100 bash scripts/oidc-authorize-canary.sh
```

Use the issuer and client ID owned by your deployment; the values above are
examples. See the
[`deploy/oidc/CUTOVER-CHECKLIST.md`](https://github.com/GroepOnline/opencodex/blob/main/deploy/oidc/CUTOVER-CHECKLIST.md)
for the generic dual-run and cutover contract. Merging product code is not a
production cutover.

## See also

- [Web Dashboard](/guides/web-dashboard/) — sign-in behaviour
- [Configuration](/reference/configuration/) — container and `OIDC_*` notes
