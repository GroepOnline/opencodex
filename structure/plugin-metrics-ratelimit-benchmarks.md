# Plugin, metrics, rate-limit, and benchmark plan

Status: implementation plan for staged pull requests targeting `dev`.

## Why this is not a direct file drop

A generated improvement bundle proposed new `plugins`, `observability`,
`ratelimit`, and `validate` modules. The current runtime already has strict
TypeScript, canonical config validation, request and usage logging, memory
sampling, observation CLI surfaces, management APIs, and token/provider/model
cost estimation. New work must extend those systems instead of introducing
parallel implementations.

The generated bundle must therefore not be copied into the repository as-is.
In particular:

- do not add a second config validator or a top-level `ocx validate` command;
- do not estimate cost from request duration;
- do not enable a prompt "sanitizer" that rewrites user messages;
- do not expose unauthenticated metrics on remotely bound listeners;
- do not bypass rate limiting from caller-controlled `Origin` headers.

## Delivery model

Implement this plan as five reviewable pull requests. Every PR targets `dev`.
Stacked child PRs may temporarily target an open parent branch and must be
retargeted to `dev` after the parent lands.

1. Typed plugin contract.
2. Prometheus-compatible metrics projection and export.
3. Admission-aware rate limiting.
4. Config diagnostics enhancements.
5. Benchmark harness and CI artifact.

## 1. Typed plugin contract v1

The first version is an internal, compile-time registration API. It is not an
arbitrary dynamic-code loader.

Initial hooks:

- `beforeAdapterRequest`
- `afterAdapterEvent`
- `onRequestComplete`
- `onRequestError`

Requirements:

- Preserve the adapter event contract, event ordering, terminal events,
  cancellation, backpressure, tool calls, image content, and streaming
  behavior.
- Hooks are observational in v1: payloads are immutable. Pass each hook a
  frozen or defensively copied payload so a plugin cannot mutate the shared
  request or a streamed event in place, reorder adapter events, or corrupt an
  active stream.
- Each hook has a typed return value. `beforeAdapterRequest`,
  `afterAdapterEvent`, `onRequestComplete`, and `onRequestError` return `void`
  in v1; plugins cannot replace, veto, or cancel requests or events. Any
  future mutation or veto capability requires a new, explicitly typed result
  contract and its own security review; it must never be inferred from a
  mutated payload object.
- Define the default action for hook timeout and failure per hook: log the
  failure through redacted diagnostics, skip the failing plugin for the rest
  of that request, and continue processing unchanged. Hook failure never
  alters, delays, or cancels the underlying request or stream.
- Expose a redacted request context by default. Prompts, headers, credentials,
  OAuth tokens, account identifiers, and raw request bodies are outside the v1
  capability boundary.
- The redaction boundary applies to every hook payload, not only the request
  context. `afterAdapterEvent` payloads must redact streamed text content,
  tool-call arguments, tool results, and image data by default, exposing only
  typed structural metadata (event kind, sequence position, byte/token
  counts, terminal status). Field-level redaction rules are defined per hook,
  and focused tests must cover streaming, tool-call, and image event payloads.
- Enforce deterministic registration order and reject duplicate plugin IDs.
- Apply a bounded per-hook timeout and isolate plugin failures. A plugin failure
  must not crash the proxy or corrupt an active stream.
- Keep hook payloads typed by lifecycle phase rather than using an unbounded
  generic object.
- Record plugin failures through existing redacted diagnostics without logging
  plugin payloads.

Explicit non-goals:

- Runtime loading from arbitrary filesystem paths or packages.
- Prompt rewriting based on injection-like phrases. Text such as "ignore
  previous instructions" can be legitimate input, and string replacement is
  not a reliable trust boundary.
- Cost tracking as a plugin. Cost remains derived from canonical usage data and
  `src/usage/cost.ts`.

## 2. Prometheus-compatible metrics

Metrics are a projection of existing lifecycle, request-log, usage, cost, and
memory state. They must not become a second logging pipeline.

Suggested metrics:

- request totals by surface, adapter/provider class, status class, and terminal
  status;
- request duration and time-to-first-token histograms;
- active turns and draining state;
- token totals by input, output, cache-read, and cache-write category;
- process uptime and memory counters;
- rate-limit allow and deny totals after phase 3.

Requirements:

- Labels are bounded. Never use request IDs, conversation IDs, account IDs, raw
  model IDs, URLs, error messages, or arbitrary caller values as labels.
- `/metrics` and `/api/metrics/json` both follow the existing admission
  boundary: on exposed hosts each requires management authorization, and the
  existing safe loopback policy applies identically to both.
- `/api/metrics/json` is added through the existing management router for GUI
  consumption and inherits its admission checks; it must not gain a separate,
  weaker access path.
- Regression tests must prove unauthenticated requests to `/metrics` and
  `/api/metrics/json` are rejected on exposed (non-loopback) listeners.
- Never export prompts, headers, credentials, local paths, identity fields, or
  unredacted upstream errors.
- Snapshot generation must be bounded and must not delay request streaming.
- Histogram buckets and metric names are stable once documented.

## 3. Admission-aware rate limiting

Rate limiting is split by API surface and keyed by a stable authenticated
principal where available.

Policies should cover:

- management API;
- Responses HTTP;
- Responses WebSocket admission;
- Chat Completions;
- Claude Messages;
- images;
- search and live endpoints;
- model discovery where applicable.

Principal selection order:

1. OpenCodex admission-key identity, represented only by a keyed,
   non-reversible internal fingerprint;
2. authenticated management principal;
3. remote socket address only where Bun exposes a trustworthy address;
4. a bounded anonymous bucket when no stable principal exists.

Requirements:

- Never key buckets by a raw API key, Authorization header, email, account ID,
  model, prompt, or other user content.
- Principal fingerprints are computed with an HMAC (for example HMAC-SHA-256)
  over the principal using a server-side secret generated at first use, never
  a plain unkeyed digest: low-entropy principals such as account identifiers
  must not be brute-forceable offline. Use a domain-separation tag per
  fingerprint purpose so rate-limit keys cannot be correlated with other
  fingerprint uses. Rotating the secret invalidates existing buckets and
  starts fresh ones; that is acceptable. The secret is never logged, exported,
  or included in diagnostics; fingerprints live only in process memory and are
  never persisted, and logs carry at most the bounded fingerprint prefixes
  allowed below.
- Do not trust `Origin` as a bypass signal; non-browser clients can set it.
- Loopback bypass or relaxed limits are explicit config choices.
- Use token-bucket semantics with monotonic time, bounded burst, stale-bucket
  eviction, and a hard cap on bucket count.
- Token consumption is atomic per bucket: read, refill, decrement, and persist
  happen as one synchronous operation on the bucket state, with no `await`
  point inside it, so concurrent requests can never observe and spend the same
  balance. Any future async or shared-store backend must preserve this
  atomicity boundary explicitly.
- Define the hard-cap fallback: when the bucket count is at the cap and no
  stale bucket is evictable, fail closed by charging the request against a
  bounded shared overflow bucket (or rejecting with the surface's `429`
  envelope) instead of allocating a new bucket or waving the request through.
- Return the correct API-specific `429` envelope and integer `Retry-After`.
- Charge WebSocket request limits at handshake. Long-lived stream concurrency is
  a separate protection from requests-per-minute accounting.
- Bound WebSocket concurrency explicitly: enforce a per-principal and a global
  cap on concurrent open connections. Reserve a connection slot before the
  handshake completes, roll the reservation back if the handshake fails, and
  release the slot on disconnect (including abnormal closes and timeouts) so
  long-lived connections cannot exhaust resources without further
  request-rate charges.
- Add optional, backward-compatible settings through the canonical `OcxConfig`
  Zod schema and the existing config load/save reconciliation flow. There is
  no generic migration mechanism to hook into; write a feature-specific
  migration only if a persisted representation later requires an actual
  transformation.
- Aggregate statistics may expose counts. Raw principals are never exposed;
  fingerprint prefixes are allowed only when necessary for an authenticated
  management diagnostic.

## 4. Existing config validation

Enhance `ocx config validate`; do not add another command or validator.
Structural validation remains in the canonical Zod/config path. Add a separate
machine-readable diagnostics layer for warnings and information.

Candidate diagnostics:

- exposed hostname without sufficient admission protection;
- privileged port;
- provider/default-provider inconsistencies not already rejected structurally;
- placeholder or unsafe provider destinations using the existing destination
  policy;
- contradictory rate-limit settings after phase 3;
- duplicate or unsupported plugin registration after phase 1.

Requirements:

- Preserve `--json` output with a versioned, additive envelope: existing fields
  keep their meaning, new diagnostics data lands under new fields (for example
  a `diagnostics` array plus a `schemaVersion` marker), and existing consumers
  keep parsing without changes.
- Define the severity-to-exit mapping explicitly: structural validation errors
  and `error`-severity diagnostics exit nonzero; `warning` and `info`
  diagnostics exit zero by default, with an opt-in strict flag to make
  warnings fail. Automation must never silently accept an invalid or unsafe
  configuration because a diagnostic was demoted to stdout only.
- Add compatibility tests covering the JSON envelope shape and the
  severity-to-exit mapping.
- Give every diagnostic a stable code, severity, path, message, and suggested
  action.
- Never include secret values.
- Avoid duplicating rules already enforced by the canonical parser.

## 5. Benchmark harness

Benchmarks land only after the APIs above stabilize.

Use a Bun-native harness or `mitata` as a development dependency. Do not add a
production runtime dependency.

Benchmarks:

- plugin dispatch with 0, 1, and 8 no-op plugins;
- metrics counter/histogram updates and Prometheus serialization;
- rate-limit lookup and consume with 1, 100, and 10,000 principals;
- config diagnostics on representative small and large configs.

Requirements:

- Include warmup, repeated samples, deterministic fixtures, and
  machine-readable JSON output.
- CI initially publishes benchmark output as an informational artifact.
- Blocking regression thresholds are introduced only after stable baselines
  exist across Linux, macOS, and Windows runners.

## Required validation

Every runtime PR runs:

```bash
bun run typecheck
bun test tests/FOCUSED_SUBSYSTEM.test.ts   # substitute the lane's test file, e.g. tests/plugins.test.ts
bun run test
bun run privacy:scan
```

`FOCUSED_SUBSYSTEM` is a placeholder, not an executable path: each lane
substitutes the focused test file it adds (plugin contract, metrics export,
rate limiting, config diagnostics, or benchmark harness) before running the
command.

Additionally:

- admission, auth/CORS, management endpoint, and config changes require explicit
  security review;
- user-visible config and endpoint behavior updates `docs-site/`;
- no implementation or planning artifacts are added under `devlog/`;
- new configuration is optional and backward compatible;
- focused regression tests prove failure isolation and privacy boundaries.

## Completion criteria

The full lane is complete when:

- no duplicate config-validation or cost-estimation subsystem exists;
- no default plugin mutates prompt content;
- metrics have bounded labels and respect management admission;
- rate limiting cannot be bypassed with spoofed `Origin` headers;
- existing adapter and streaming tests remain green;
- all new behavior has focused tests and operational documentation;
- the benchmark job produces comparable JSON artifacts without gating releases
  prematurely.
