# opencodex

A local Responses-compatible proxy for Codex. It writes a provider table and model catalog, then serves Codex clients through routing and an adapter bridge. It does not patch Codex binaries.

## Language

**Responses turn**:
One client request at `/v1/responses` (or the Claude-messages equivalent) that may include several upstream attempts.
_Avoid_: request handler, orchestration, HTTP call

**Provider table**:
The configured set of providers, accounts, and models the proxy may route to.
_Avoid_: registry overlay, preset list (those are how the table is derived, not the table)

**Availability**:
Who may take an attempt, and whether an outcome hops or surfaces. Includes pre-request selection. Owns live routing state (active key, cooldowns, cap-disable). Does not include operator quota bars. Does not own how provider-table rows are derived, discovered, or overlaid.
_Avoid_: failover, retry policy, hop adapter

**Live routing state**:
Which credential is active and which candidates are cooling or cap-disabled. Availability may persist this. Distinct from overlay (defaults, discovery, new rows). The operator inspects and clears it through management; the request log does not record it on its own.
_Avoid_: config, provider settings, registry

**Candidate**:
The fetch-ready provider, credential, and model for this attempt, including the token or headers the attempt needs. Codex tokens, probe leases, and apiKey swaps stay inside Availability. Wire/adapter choice is not part of a Candidate.
_Avoid_: route, adapter, account (unqualified)

**Attempt**:
One upstream try inside a Responses turn.
_Avoid_: retry, hop (a hop starts a new attempt; it is not itself the try)

**Outcome**:
What the upstream returned for an attempt (status, Retry-After, error text, whether a terminal was seen). The Responses turn passes this evidence in; Availability decides hop or surface.
_Avoid_: response (that word is the Codex wire)

**Hop**:
Start another attempt with the next candidate. Combo targets and a provider's fallback list are the same hop; there is no separate synthetic combo.
_Avoid_: failover, rotate, fallback (as a second mechanism)

**Surface**:
Return the outcome to the Codex client and stop hopping.
_Avoid_: throw, fail, passthrough

**Operator quota**:
Usage bars shown to the operator on the dashboard. A read model, not an availability decision.
_Avoid_: quota (unqualified — Codex WHAM snapshots and vendor probes are different seams)
