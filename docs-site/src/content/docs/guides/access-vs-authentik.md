---
title: Cloudflare Access vs Authentik OIDC
description: How the OpenCodex dashboard uses Cloudflare Access today and Authentik OIDC as the product consumer.
---

OpenCodex has two human-dashboard gates. They are not interchangeable today.

| Gate                          | What the proxy checks                                                                                                                     | Live on `ocx.chefgroep.online`               | When to use                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------ |
| **Cloudflare Access**         | `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` JWT (`cf-access-jwt-assertion` or `CF_Authorization`)                                           | **Yes** — current public GUI gate            | Production public host until cutover       |
| **Authentik OIDC**            | Issuer `https://auth.chefgroep.online/application/o/ocx/`, client `chefgroep-ocx-oidc`, JWKS ID-token verify, optional `GET /oauth/login` | Consumer wired; **not** the live public gate | Local canary and the later Access cutover  |
| **Admin token / GUI session** | `OPENCODEX_ADMIN_AUTH_TOKEN` or loopback-minted session                                                                                   | Unchanged                                    | Loopback and Tailscale without Access/OIDC |
| **Service API token**         | `OPENCODEX_API_AUTH_TOKEN`                                                                                                                | Unchanged                                    | Data-plane `/v1/*` only                    |

Authentik is also the Cloudflare Access identity provider. Product OIDC means
the **proxy** verifies ChefGroep Auth tokens itself (`GET /oauth/login` →
`/oauth/callback`, then an `ocx_oidc` cookie or a Bearer ID token). It does not
register a second client in ChefFactory.

`GET /healthz` on `:10100` stays unauthenticated on both planes.

## Environment (no secrets)

Copy [`.env.example`](https://github.com/GroepOnline/opencodex/blob/main/.env.example).
Never set `OIDC_CLIENT_SECRET` in the environment or in git.

```bash
OIDC_ISSUER=https://auth.chefgroep.online/application/o/ocx/
OIDC_CLIENT_ID=chefgroep-ocx-oidc
OIDC_CLIENT_SECRET_FILE=/path/to/oidc-client-secret
OIDC_REDIRECT_URI=http://127.0.0.1:10100/oauth/callback
OIDC_ALLOWED_HOSTS=ocx.chefgroep.online
```

Token verify needs issuer + client id. The browser authorize flow also needs
the secret file and a redirect URI from
`deploy/oidc/authentik-ocx-client.placeholder.json`.

## Canary

```bash
bash scripts/oidc-authorize-canary.sh
OPENCODEX_OIDC_CANARY_URL=http://127.0.0.1:10100 bash scripts/oidc-authorize-canary.sh
```

The operator checklist for dual-run and Cloudflare Access cutover is
[`deploy/oidc/CUTOVER-CHECKLIST.md`](https://github.com/GroepOnline/opencodex/blob/main/deploy/oidc/CUTOVER-CHECKLIST.md).
Merging the consumer does not move the live `1.4.2` place lock and is not a
cutover.

## See also

- [Web Dashboard](/guides/web-dashboard/) — sign-in behaviour
- [Configuration](/reference/configuration/) — container and `OIDC_*` notes
