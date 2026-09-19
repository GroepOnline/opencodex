# Authentik OIDC canary and CoS / Cloudflare cutover

This is the operator checklist for the product Authentik consumer
(`chefgroep-ocx-oidc`). It does **not** move the live place lock
(`opencodex-proxy` @ 1.4.2 / `529bb6a9`) and it does **not** deploy to
`bc-scan-2`. `/healthz` stays unauthenticated on `:10100`.

Cloudflare Access remains the live public-host dashboard gate on
`ocx.chefgroep.online` until every cutover box is checked.

## Planes

| Plane                                 | Who it authenticates                                                                                           | Live today                                   | Product path         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------- |
| Cloudflare Access                     | Browser users at the edge (`CF_Authorization` / `cf-access-jwt-assertion`)                                     | **Yes** — public GUI gate                    | Keep until cutover   |
| Authentik OIDC (`chefgroep-ocx-oidc`) | Browser users at the proxy (`GET /oauth/login` → `/oauth/callback`, then `ocx_oidc` cookie or Bearer ID token) | Consumer wired; **not** the live public gate | Canary, then cutover |
| Service API token                     | Data-plane `/v1/*`                                                                                             | Unchanged                                    | Unchanged            |

Authentik is also the Cloudflare Access IdP. Cutting over means the **proxy**
verifies ChefGroep Auth tokens itself so Access can later be removed from the
hostname. It is not a second identity provider.

## Preconditions (CoS)

- [ ] Issuer `https://auth.chefgroep.online/application/o/ocx/` discovery and JWKS return 200 (APPLY DONE 2026-09-18; not DNS HOLD).
- [ ] Client id is `chefgroep-ocx-oidc`. Client secret exists only in `OIDC_CLIENT_SECRET_FILE` on the host (never git, never ChefFactory catalog).
- [ ] Redirect URIs in Authentik still match `deploy/oidc/authentik-ocx-client.placeholder.json`.
- [ ] Live pin is still `1.4.2` / `529bb6a9`. This checklist does not retarget it.
- [ ] `GET http://127.0.0.1:10100/healthz` (and the host Tailscale IPv4) still returns `status=ok`, `service=opencodex`.

## Authorize canary (no live cutover)

Run from a laptop or the host. Do not put the client secret on the command line.

```bash
# 1) Issuer still live (no secrets)
bash scripts/oidc-authorize-canary.sh

# 2) Optional: against a running local/dev proxy with OIDC_* set
OPENCODEX_OIDC_CANARY_URL=http://127.0.0.1:10100 bash scripts/oidc-authorize-canary.sh
```

Then, only on a **non-production** bind or a loopback tunnel:

- [ ] `GET /oauth/login` returns 302 to `https://auth.chefgroep.online/application/o/authorize/` with `client_id=chefgroep-ocx-oidc`, `state`, `nonce`, and `code_challenge_method=S256`.
- [ ] Completing login (human browser) lands on `/oauth/callback` then `/` with an `ocx_oidc` cookie.
- [ ] `GET /api/usage` from that browser succeeds without `ocx_admin_*`.
- [ ] `GET /healthz` still works without cookies or tokens.
- [ ] `GET /v1/models` still requires the data-plane token (OIDC must not admit the data plane).
- [ ] A forged host or missing/invalid ID token still returns 401 on `/api/*`.

If any canary box fails, stop. Cloudflare Access stays in front.

## Cloudflare Access dual-run

While Access is still the live gate:

- [ ] Keep `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and `CF_ACCESS_ALLOWED_HOSTS=ocx.chefgroep.online`.
- [ ] Set `OIDC_ISSUER`, `OIDC_CLIENT_ID=chefgroep-ocx-oidc`, `OIDC_CLIENT_SECRET_FILE`, `OIDC_REDIRECT_URI=https://ocx.chefgroep.online/oauth/callback`, and `OIDC_ALLOWED_HOSTS=ocx.chefgroep.online` on the host `.env` only.
- [ ] Confirm Access login still opens the dashboard (regression).
- [ ] Confirm `/oauth/login` can complete behind Access (Access may already have authenticated the browser; the product callback must still succeed).
- [ ] Confirm `/healthz` on `:10100` is unchanged.

## Cutover (only after canary + dual-run)

Do this in a later release that **intentionally** moves the live pin. Not this PR.

- [ ] Product OIDC canary stayed green for the agreed soak window.
- [ ] Dual-run showed Access and Authentik both admitting the GUI, and neither admitting `/v1/*`.
- [ ] Change `OIDC_REDIRECT_URI` / Authentik redirect to the public callback only if local loopback URIs should drop.
- [ ] Remove the Cloudflare Access application from `ocx.chefgroep.online` (or bypass it) **after** OIDC-only admission is proven.
- [ ] Unset `CF_ACCESS_*` on the host only after Access is gone.
- [ ] Re-check `/healthz` on loopback and Tailscale `:10100`.
- [ ] Keep a rollback: restore `CF_ACCESS_*`, re-enable the Access application, restart `opencodex-proxy`. The 1.4.2 pin is the rollback identity until a later tag.

## Never from this repository

- Do not apply Cloudflare DNS.
- Do not register `chefgroep-ocx-oidc` in ChefFactory catalogs.
- Do not commit a client secret.
- Do not treat merge of the consumer PR as a live cutover.
