# OIDC canary and edge cutover checklist

This checklist describes the product-level OIDC acceptance contract. It is
intentionally deployment-neutral: production hostnames, private addresses,
client identifiers, current versions and live cutover evidence belong in the
operator's private deployment repository.

## Planes

| Plane | Purpose |
| --- | --- |
| Edge authentication | Optional outer browser gate during migration/dual-run. |
| Product OIDC | Browser identity consumed directly by the OpenCodex proxy. |
| Service API token / client keys | Data-plane `/v1/*` admission. OIDC must not grant this plane. |
| Admin token / product session | Management-plane admission. |

## Preconditions

- [ ] OIDC issuer discovery returns 200.
- [ ] JWKS URI from discovery returns 200 and matches the configured issuer.
- [ ] The client is confidential when a client-secret file is configured.
- [ ] Redirect URIs exactly match the deployment's loopback/public callbacks.
- [ ] Client secret exists only in the secret/runtime plane.
- [ ] `GET /healthz` proves the exact intended runtime artifact.
- [ ] Data-plane admission remains independent from browser/OIDC admission.

## Authorize canary

Against a non-production bind or explicitly approved canary:

- [ ] `GET /oauth/login` returns 302 to the configured issuer's authorization endpoint.
- [ ] Request contains `state`, `nonce`, `code_challenge`, and `code_challenge_method=S256`.
- [ ] Completing login returns to `/oauth/callback` and establishes an HttpOnly product session.
- [ ] No authorization code, access token or ID token remains in the final URL.
- [ ] An authenticated browser can use the intended management surface.
- [ ] `GET /healthz` still works according to the deployment health policy.
- [ ] `GET /v1/models` still requires data-plane credentials.
- [ ] Forged host, issuer, state, nonce or ID token fails closed.
- [ ] Logout and issuer-side revocation remove dashboard access.

The repository includes `scripts/oidc-authorize-canary.sh` for
secret-free discovery/JWKS and optional login-start checks.

## Edge dual-run

If an outer access gateway is used during migration:

- [ ] Keep the existing edge gate until product OIDC has completed canary and soak.
- [ ] Verify both layers do not accidentally widen `/v1/*` admission.
- [ ] Verify rollback before removing the edge gate.
- [ ] Remove old edge-specific environment only after OIDC-only access is proven.

## Cutover

- [ ] Canary stayed green for the agreed soak window.
- [ ] Exact runtime artifact and rollback artifact are recorded privately.
- [ ] Public callback is proven end-to-end.
- [ ] Logout, expiry and denied-user cases are proven.
- [ ] Edge policy changes are applied by the repository/system that owns them.
- [ ] Post-cutover health and authenticated management/data-plane probes pass.

## Never from this repository

- Do not apply production DNS or edge policy.
- Do not commit client secrets, service tokens or browser credentials.
- Do not encode a private host/IP/release path as the product deployment target.
- Do not treat a merge, package publish or image publish as production cutover.
