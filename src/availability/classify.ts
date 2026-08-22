import { comboFailureDecision } from "../combos/failover";

/** Raw evidence from one upstream attempt. The Responses turn passes this in. */
export type AttemptEvidence = {
  status: number;
  message: string;
  code?: string | null;
};

/** Whether Availability starts another attempt or returns the outcome to the client. */
export type AvailabilityDecision = "hop" | "surface";

/**
 * Classify hop versus surface. Combo-target failure, provider fallback, and
 * account-pool rotation all use this; key-pool rotation additionally requires
 * {@link isAccountPoolHopStatus}.
 */
export function classifyAttempt(evidence: AttemptEvidence): AvailabilityDecision {
  return comboFailureDecision(evidence.status, evidence.message, { code: evidence.code }) === "hop"
    ? "hop"
    : "surface";
}

/** 429 rate-limit and 529 overload are the statuses that rotate key/Codex pools. */
export function isAccountPoolHopStatus(status: number): boolean {
  return status === 429 || status === 529;
}

/** OAuth account pools also own account-scoped 402 quota/payment-cap failures. */
export function isOauthAccountPoolHopStatus(status: number): boolean {
  return isAccountPoolHopStatus(status) || status === 402;
}
