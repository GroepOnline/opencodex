export const OCX_MAX_UPSTREAM_ATTEMPTS = 3;

export interface UpstreamAttemptBudget {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  tryBegin(): boolean;
}

export function createUpstreamAttemptBudget(
  limit = OCX_MAX_UPSTREAM_ATTEMPTS,
): UpstreamAttemptBudget {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  let used = 0;
  return {
    get limit() {
      return normalizedLimit;
    },
    get used() {
      return used;
    },
    get remaining() {
      return Math.max(0, normalizedLimit - used);
    },
    tryBegin() {
      if (used >= normalizedLimit) return false;
      used += 1;
      return true;
    },
  };
}
