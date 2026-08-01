import { readBoundedResponseBody } from "./bounded-body";

export type UpstreamRail = "generic" | "cursor" | "google" | "kiro";

export type UpstreamOutcomeLabel =
  | "success"
  | "client-abort"
  | "adapter-eof"
  | "context-overflow"
  | "rate-limit"
  | "quota-exhausted"
  | "billing"
  | "empty-pool"
  | "transient-transport"
  | "authentication"
  | "invalid-request"
  | "other";

export interface UpstreamOutcomeEvidence {
  status?: number;
  message?: string;
  code?: string | null;
}

export interface UpstreamOutcomePolicy {
  sameAccountRetry: boolean;
  rotateOrCool: boolean;
  failover: boolean;
}

const NO_RECOVERY: UpstreamOutcomePolicy = {
  sameAccountRetry: false,
  rotateOrCool: false,
  failover: false,
};

const OUTCOME_POLICIES: Record<UpstreamOutcomeLabel, UpstreamOutcomePolicy> = {
  success: NO_RECOVERY,
  "client-abort": NO_RECOVERY,
  "adapter-eof": NO_RECOVERY,
  "context-overflow": NO_RECOVERY,
  billing: NO_RECOVERY,
  "empty-pool": NO_RECOVERY,
  authentication: NO_RECOVERY,
  "invalid-request": NO_RECOVERY,
  // Transient throttle may same-account retry; account pools still cool/rotate.
  "rate-limit": { sameAccountRetry: true, rotateOrCool: true, failover: true },
  "quota-exhausted": { sameAccountRetry: false, rotateOrCool: true, failover: true },
  "transient-transport": { sameAccountRetry: true, rotateOrCool: false, failover: true },
  other: NO_RECOVERY,
};

export function upstreamOutcomePolicy(label: UpstreamOutcomeLabel): UpstreamOutcomePolicy {
  return OUTCOME_POLICIES[label];
}

function evidenceText(evidence: UpstreamOutcomeEvidence): string {
  return `${evidence.code ?? ""} ${evidence.message ?? ""}`.trim().toLowerCase();
}

function isContextOverflow(text: string): boolean {
  return text.includes("context_length_exceeded")
    || text.includes("context window")
    || text.includes("context length")
    || text.includes("maximum context")
    || text.includes("input exceeds")
    || text.includes("too many tokens");
}

function isClientAbort(status: number | undefined, text: string): boolean {
  return status === 499
    || text.includes("client_closed_request")
    || text.includes("client cancelled request")
    || text.includes("client canceled request")
    || text.includes("client closed request")
    || text.includes("request was aborted")
    || text.includes("request canceled by client")
    || text.includes("request cancelled by client");
}

function isAdapterEof(text: string): boolean {
  return text.includes("adapter_eof")
    || text.includes("upstream stream ended unexpectedly without a terminal event");
}

function classifyShared(evidence: UpstreamOutcomeEvidence): UpstreamOutcomeLabel {
  const status = evidence.status;
  const text = evidenceText(evidence);
  if (status !== undefined && status >= 200 && status < 400) return "success";
  if (isClientAbort(status, text)) return "client-abort";
  if (isAdapterEof(text)) return "adapter-eof";

  // Overflow wins over RESOURCE_EXHAUSTED, 429, and quota words. It is a request
  // property and must never cool an account or trigger a replay.
  if (isContextOverflow(text)) return "context-overflow";

  if (
    text.includes("billing")
    || text.includes("payment required")
    || text.includes("plan package has expired")
  ) return "billing";
  if (
    text.includes("pool has no usable")
    || text.includes("no eligible account")
    || text.includes("empty pool")
  ) return "empty-pool";
  if (
    text.includes("insufficient_quota")
    || text.includes("quota exhausted")
    || text.includes("quota exceeded")
    || text.includes("usage limit has been reached")
  ) return "quota-exhausted";
  if (
    status === 429
    || text.includes("resource_exhausted")
    || text.includes("resource exhausted")
    || text.includes("rate limit")
    || text.includes("too many requests")
    || text.includes("throttl")
  ) return "rate-limit";
  if (
    status === 401
    || status === 403
    || text.includes("unauthorized")
    || text.includes("unauthenticated")
    || text.includes("invalid api key")
    || text.includes("invalid token")
  ) return "authentication";
  if (
    status === 408
    || status === 500
    || status === 502
    || status === 503
    || status === 504
    || status === 520
    || status === 521
    || status === 522
    || text.includes("econnreset")
    || text.includes("econnrefused")
    || text.includes("connection reset")
    || text.includes("temporarily unavailable")
    || text.includes("server overloaded")
  ) return "transient-transport";
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return "invalid-request";
  }
  return "other";
}

export function classifyGenericUpstreamOutcome(
  evidence: UpstreamOutcomeEvidence,
): UpstreamOutcomeLabel {
  return classifyShared(evidence);
}

export function classifyCursorUpstreamOutcome(
  evidence: UpstreamOutcomeEvidence,
): UpstreamOutcomeLabel {
  return classifyShared(evidence);
}

export function classifyGoogleUpstreamOutcome(
  evidence: UpstreamOutcomeEvidence,
): UpstreamOutcomeLabel {
  return classifyShared(evidence);
}

export function classifyKiroUpstreamOutcome(
  evidence: UpstreamOutcomeEvidence,
): UpstreamOutcomeLabel {
  return classifyShared(evidence);
}

export function classifyUpstreamOutcome(
  rail: UpstreamRail,
  evidence: UpstreamOutcomeEvidence,
): UpstreamOutcomeLabel {
  switch (rail) {
    case "cursor":
      return classifyCursorUpstreamOutcome(evidence);
    case "google":
      return classifyGoogleUpstreamOutcome(evidence);
    case "kiro":
      return classifyKiroUpstreamOutcome(evidence);
    case "generic":
      return classifyGenericUpstreamOutcome(evidence);
    default: {
      const exhaustive: never = rail;
      return exhaustive;
    }
  }
}

export async function classifyUpstreamResponse(
  rail: UpstreamRail,
  response: Response,
  signal?: AbortSignal,
): Promise<UpstreamOutcomeLabel> {
  if (response.ok) return "success";
  // Clear gateway/transport statuses need no body peek. Avoid hanging on open streams.
  if (
    response.status === 500
    || response.status === 502
    || response.status === 503
    || response.status === 504
    || response.status === 520
    || response.status === 521
    || response.status === 522
  ) {
    return classifyUpstreamOutcome(rail, { status: response.status });
  }
  let message = "";
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    if (body.displaySafe) message = body.text;
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return classifyUpstreamOutcome(rail, {
    status: response.status,
    message,
  });
}
