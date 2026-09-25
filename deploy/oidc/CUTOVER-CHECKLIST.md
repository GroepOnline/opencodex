# Authentik OIDC canary and CoS / Cloudflare cutover

This is the operator checklist for the product Authentik consumer
(`chefgroep-ocx-oidc`). It does **not** move the live place lock and it
does **not** deploy to `bc-scan-2`. `/healthz` stays unauthenticated on
`:10100`. There is no `/health` contract — that path is a JSON 404.

**Dual-run (2026-09-20):** Cloudflare Access remains the live public-host
dashboard gate on `ocx.chefgroep.online`. Product OIDC is wired in the
consumer and host env, but is **not** the public gate. Rollback = keep
Access enabled and keep the previous release tree.

## Planes

| Plane                                 | Who it authenticates                                                                                      | Live today                                   | Product path         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------- |
| Cloudflare Access                     | Browser users at the edge (`CF_Authorization` / `cf-access-jwt-assertion`)                                | **Yes** — public GUI gate                    | Keep until cutover   |
| Authentik OIDC (`chefgroep-ocx-oidc`) | Browser users at the proxy (`GET /oauth/login` → flow cookie → `/oauth/callback`, then `ocx_oidc` cookie) | Consumer wired; **not** the live public gate | Canary, then cutover |
| Service API token                     | Data-plane `/v1/*`                                                                                        | Unchanged                                    | Unchanged            |

Authentik is also the Cloudflare Access IdP. Cutting over means the **proxy**
verifies ChefGroep Auth tokens itself so Access can later be removed from the
hostname. It is not a second identity provider.

## Observed live state (read-only, refreshed 2026-09-24)

- [x] Issuer `https://auth.chefgroep.online/application/o/ocx/` discovery returns 200. JWKS URI in that document is live. Introspection is `https://auth.chefgroep.online/application/o/introspect/` (same origin).
- [x] Client id is `chefgroep-ocx-oidc`. Client type in Authentik is `confidential`. Secret exists only in `OIDC_CLIENT_SECRET_FILE` on the host (never git).
- [x] Authentik redirect URIs that match this consumer (`STRICT`):
      `http://127.0.0.1:10100/oauth/callback`,
      `http://localhost:10100/oauth/callback`,
      `https://ocx.chefgroep.online/oauth/callback`.
      Extra registered URIs (not used by this code; **do not change from this repo**):
      `/oauth2/callback`, `/api/auth/callback`, `/auth/callback`, `/oidc/callback`,
      and the Cloudflare Access callback.
- [x] Host `.env` names set (values not recorded): `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
      `OIDC_CLIENT_SECRET_FILE`, `OIDC_REDIRECT_URI`, `OIDC_ALLOWED_HOSTS`, plus
      `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `CF_ACCESS_ALLOWED_HOSTS`.
- [x] Actual running artifact is npm package **1.5.0** from
      `/home/joep/.opencodex/releases/f5cc348b7f0b7a48a9241cac17714399c2777c0f`
      (`start-service.sh` → `src/cli/index.ts start --port 10100`). The unit-file
      comment and runtime health identity cite tag `v1.5.0` / source SHA
      `f5cc348b7f0b7a48a9241cac17714399c2777c0f`.
- [x] `GET http://100.65.83.86:10100/healthz` returns `status=ok`,
      `service=opencodex`, `version=1.5.0`, and source SHA `f5cc348b7…`.
      Bind is the Tailscale IPv4, not 127.0.0.1. Public
      `https://ocx.chefgroep.online/` is still a Cloudflare Access 302.
- [ ] systemd `opencodex-proxy.service` is **not** healthy: `ActiveState=activating`,
      `NRestarts` in the thousands, because PID `3197646` already holds
      `:10100` and `ocx start` refuses a duplicate. The orphan process is the
      live listener. Do not treat the unit as the source of truth until an
      operator reconciles that (out of scope for this PR; no live write).

## Preconditions (CoS)

- [x] Issuer `https://auth.chefgroep.online/application/o/ocx/` discovery and JWKS return 200 (APPLY DONE 2026-09-18; not DNS HOLD).
- [x] Client id is `chefgroep-ocx-oidc`. Client secret exists only in `OIDC_CLIENT_SECRET_FILE` on the host (never git, never ChefFactory catalog).
- [x] Redirect URIs required by `deploy/oidc/authentik-ocx-client.placeholder.json` are present. Extra unused URIs remain; leave them.
- [x] Live package version is `1.5.0`. Running tree SHA is `f5cc348b7`. This checklist does not retarget the pin.
- [x] `GET http://100.65.83.86:10100/healthz` still returns `status=ok`, `service=opencodex`.

## Authorize canary (no live cutover)

Run from a laptop or the host. Do not put the client secret on the command line.

```bash
# 1) Issuer still live (no secrets)
bash scripts/oidc-authorize-canary.sh

# 2) Optional: against a running local/dev proxy with OIDC_* set
OPENCODEX_OIDC_CANARY_URL=http://127.0.0.1:10100 bash scripts/oidc-authorize-canary.sh
```

Then, only on a **non-production** bind or a loopback tunnel:

- [ ] `GET /oauth/login` returns 302 to `https://auth.chefgroep.online/application/o/authorize/` with `client_id=chefgroep-ocx-oidc`, `state`, `nonce`, `code_challenge_method=S256`, and an HttpOnly `ocx_oidc_flow` cookie.
- [ ] Completing login (human browser) lands on `/oauth/callback` then the `return_to` path with an `ocx_oidc` cookie. No token in the URL.
- [ ] `GET /api/usage` from that browser succeeds without `ocx_admin_*`.
- [ ] `GET /healthz` still works without cookies or tokens.
- [ ] `GET /v1/models` still requires the data-plane token (OIDC must not admit the data plane).
- [ ] A forged host or missing/invalid ID token still returns 401 on `/api/*`.
- [ ] Logout (`GET /oauth/logout`) and IdP introspection revoke dashboard access on the next request.

Human browser login cannot be proven from this repository: ChefAuth has only
the bootstrap admin. Unit/integration tests cover the mocked issuer/JWKS
paths above. If any live canary box fails, stop. Cloudflare Access stays in front.

## Cloudflare Access dual-run

While Access is still the live gate:

- [x] Keep `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and `CF_ACCESS_ALLOWED_HOSTS=ocx.chefgroep.online`.
- [x] `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET_FILE`, `OIDC_REDIRECT_URI`, and `OIDC_ALLOWED_HOSTS` names are set on the host env file only.
- [x] Access login still opens the dashboard (public `/` → Cloudflare Access 302).
- [ ] Confirm `/oauth/login` can complete behind Access (Access may already have authenticated the browser; the product callback must still succeed). Human login required.
- [x] Confirm `/healthz` on Tailscale `:10100` is unchanged (`status=ok`, `service=opencodex`).

## Cutover (only after canary + dual-run)

Do this in a later release that **intentionally** moves the live pin. Not this PR.

- [ ] Product OIDC canary stayed green for the agreed soak window.
- [ ] Dual-run showed Access and Authentik both admitting the GUI, and neither admitting `/v1/*`.
- [ ] Change `OIDC_REDIRECT_URI` / Authentik redirect to the public callback only if local loopback URIs should drop.
- [ ] Remove the Cloudflare Access application from `ocx.chefgroep.online` (or bypass it) **after** OIDC-only admission is proven.
- [ ] Unset `CF_ACCESS_*` on the host only after Access is gone.
- [ ] Re-check `/healthz` on the Tailscale IPv4 and laptop tunnel loopback `:10100`.
- [ ] Keep a rollback: restore `CF_ACCESS_*`, re-enable the Access application, restart `opencodex-proxy` onto the previous release tree (`b59c2115` / 1.4.2 remains the on-disk previous release). Access stays the public gate if product OIDC is rolled back.

## Never from this repository

- Do not apply Cloudflare DNS.
- Do not register `chefgroep-ocx-oidc` in ChefFactory catalogs.
- Do not commit a client secret.
- Do not treat merge of the consumer PR as a live cutover.
- Do not edit Authentik redirect URIs from here. Report mismatches only.
