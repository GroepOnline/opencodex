---
title: Management API
---

# Management API

The dashboard and `ocx account` CLI talk to the running proxy over these routes.
They return operator data only: no raw API keys, OAuth tokens, or account identifiers
that could be replayed.

## Provider quotas

`GET /api/provider-quotas` returns quota reports for the configured providers. To
retrieve one provider independently, pass its name as the `provider` query
parameter:

```text
GET /api/provider-quotas?provider=anthropic
```

A provider slice has the same quota report shape as the aggregate response and
includes only the requested provider. Unknown provider names return `404` with
an `{ "error": "unknown provider: ..." }` response. The optional
`forceRefresh` behavior remains available as supported by the endpoint.

## Availability

`GET /api/availability` is the dashboard read-model for who may take the next
attempt. It is independent of `GET /api/config`: it does not round-trip provider
secrets.

Each provider entry includes:

- `keyPoolCount` — configured keys on that provider (a bare `apiKey` counts as one)
- `coolingKeyCount` — pooled keys Availability is currently cooling
- `hopProvider` / `hopModel` — first fallback hop, when configured
- `capUntil` / `capDisabled` — weekly/inference cap window, when active

No key material appears in this payload.

## Provider keys

`GET /api/providers/keys?name=<provider>` lists the key pool for one provider.
Keys are masked. When Availability is cooling a key, that entry includes
`cooldownUntil` (unix ms).

Related mutating routes (same path family, used by the Providers page and
`ocx account`):

- `POST /api/providers/keys` — add a key (body: `name`, `key`, optional `label`)
- `PUT /api/providers/keys/active` — switch the active key (`name`, `id`)
- `PUT /api/providers/keys/alias` — set a display alias (`name`, `id`, `alias`)
- `DELETE /api/providers/keys?name=&id=` — remove a key

Adding, switching, or removing a key also clears that provider's key-pool
cooldowns so the new set starts fetch-ready.

See [Multiple API keys](/guides/providers/#multiple-api-keys) for the operator
workflow.

## OAuth seat expiry

`PUT /api/oauth/accounts/expiry` sets the operator-owned seat window on one
OAuth account. This is distinct from `credential.expires` (the access-token
lifetime returned as `expiresAt` on `GET /api/oauth/accounts`).

```json
{
  "provider": "anthropic",
  "accountId": "aaaa1111",
  "accountExpiresAt": 1790000000000,
  "autoDisableOnExpiry": true
}
```

- `accountExpiresAt` — unix ms, or `null` to clear the seat date
- `autoDisableOnExpiry` — when `true`, an elapsed seat date latches
  `disabledByExpiry` and drops the account from same-provider routing

A `200` response echoes `accountExpiresAt`, `autoDisableOnExpiry`, and
`disabledByExpiry`. Extending the seat, clearing the date, or turning
`autoDisableOnExpiry` off clears the latch. If the latched account is the
active seat and another selectable sibling exists **on that same provider**,
the sibling becomes active. Other providers are never selected.

Tokens never appear in this payload. `accountId` is the short store id already
returned by `GET /api/oauth/accounts`.

## Account runtime

`GET /api/accounts/runtime` is the unified read-model for OAuth accounts
(Anthropic / Cursor / Antigravity) and API-key pool entries (2+ keys). Each
row includes:

- `provider`, `accountId`, `kind` (`oauth` or `key-pool`)
- `inFlight`, optional `lastUsedAt`
- optional `cooldownUntil` / `cooldownSource`
- OAuth-only: `accountExpiresAt`, `autoDisableOnExpiry`
- `disabled`, optional `disabledReason` (`expired` or `needs_reauth`)
- `selectable`

The handler applies pending auto-disable latches first, including the
same-provider active-seat demote described above. It does not return API keys,
OAuth tokens, or emails.

## Auto-router

`GET /api/router` shows what the auto-router would do right now. The auto-router
is off by default; it activates only when the config sets `router.mode` to
`"auto"`.

```json
{
  "mode": "off",
  "enabled": false,
  "weights": { "cost": 1, "latency": 1, "quality": 1 },
  "chains": []
}
```

When enabled, `chains` lists one entry per configured provider fallback chain
with the scored target order the router would pick:

- `score` — weighted composite (lower wins)
- `components` — normalized `cost`, `latency`, and static quality `tier`
- `costPer1kEur` — blended EUR estimate per 1k tokens (75/25 input/output)

Cost comes from static pricing, latency from p50 request durations in the usage
log over the last 7 days (`router.latencyWindowMs` overrides), and quality from
a coarse model-family tier table. Targets with no measured latency score a
neutral 0.5 so only evidence reorders them. Ties keep your configured order.
User-defined combos are never reordered — only automatic fallback chains.

`PUT /api/router` with body `{ "mode": "auto" }` or `{ "mode": "off" }` toggles
the router live and persists the choice to the config file.
