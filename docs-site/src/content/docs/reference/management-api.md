---
title: Management API
---

# Management API

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
