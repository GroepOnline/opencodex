/**
 * Cursor outcome fixtures distilled from sofie usage/service logs (2026-07-30 audit).
 * Counts are documentary; messages match live patterns the classifier must honor.
 */

export const CURSOR_CLIENT_ABORT_FIXTURES = [
  {
    id: "client-abort-499",
    status: 499,
    message: "client_closed_request closeReason=client_cancel",
    // service.log / usage: hundreds of abort telemetry lines; not rotate-worthy
    observedCountHint: 292,
  },
  {
    id: "client-abort-request-aborted",
    status: 499,
    message: "Cursor request was aborted",
    observedCountHint: 308,
  },
] as const;

export const CURSOR_ADAPTER_EOF_FIXTURES = [
  {
    id: "adapter-eof-502",
    status: 502,
    message: "Upstream stream ended unexpectedly without a terminal event (adapter_eof)",
    // 70 of 74 cursor 502s in sofie usage.jsonl
    observedCountHint: 70,
  },
] as const;

export const CURSOR_RATE_LIMIT_FIXTURES = [
  {
    id: "rate-limit-resource-exhausted",
    status: 429,
    message: "Cursor rate limit exceeded: resource_exhausted",
    observedCountHint: 16,
  },
  {
    id: "rate-limit-too-many-requests",
    status: 429,
    message: "Cursor rate limit exceeded: too many requests",
    observedCountHint: 16,
  },
] as const;

export const ARCHITECTURE_CONTRACT_ROWS = [
  {
    signal: "client-abort / post-commit EOF",
    label: "client-abort",
    sameAccountRetry: false,
    rotateOrCool: false,
  },
  {
    signal: "client-abort / post-commit EOF",
    label: "adapter-eof",
    sameAccountRetry: false,
    rotateOrCool: false,
  },
  {
    signal: "502/503/transport pre-commit",
    label: "transient-transport",
    sameAccountRetry: true,
    rotateOrCool: false,
  },
  {
    signal: "429/ResourceExhausted with quota-signal",
    label: "quota-exhausted",
    sameAccountRetry: false,
    rotateOrCool: true,
  },
  {
    signal: "429 throttle (no hard quota)",
    label: "rate-limit",
    sameAccountRetry: true,
    rotateOrCool: true,
  },
  {
    signal: "context-overflow / billing / empty pool",
    label: "context-overflow",
    sameAccountRetry: false,
    rotateOrCool: false,
  },
  {
    signal: "context-overflow / billing / empty pool",
    label: "billing",
    sameAccountRetry: false,
    rotateOrCool: false,
  },
  {
    signal: "context-overflow / billing / empty pool",
    label: "empty-pool",
    sameAccountRetry: false,
    rotateOrCool: false,
  },
] as const;
