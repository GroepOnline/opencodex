import type { CachedCleanupPolicy, CleanupPolicy } from "./storage-types";

export const GB = 1024 ** 3;

export const PRESETS = [10, 25, 50] as const;

export const localizedCatch = (e: unknown, fallback: string): string => {
  if (!(e instanceof Error)) return fallback;
  const msg = e.message;
  if (
    msg === "Failed to fetch" ||
    msg.includes("NetworkError") ||
    msg.includes("network error") ||
    msg.includes("JSON") ||
    msg.includes("Unexpected end of")
  ) {
    return fallback;
  }
  return msg || fallback;
};

export function policyFieldsFromResponse(json: CleanupPolicy): CleanupPolicy {
  const { job, ...policy } = json;
  void job;
  return policy;
}

export function draftsFromPolicyResponse(
  json: CleanupPolicy,
): Omit<CachedCleanupPolicy, "policy"> & { policy: CleanupPolicy } {
  const thresholdGb = String(
    Math.max(0, Math.round((json.trigger.archivedBytesOver / GB) * 100) / 100),
  );
  if (json.target.reduceToBytes !== undefined) {
    return {
      policy: policyFieldsFromResponse(json),
      thresholdGb,
      targetMode: "reduce",
      percent: "25",
      reduceGb: String(
        Math.max(0, Math.round((json.target.reduceToBytes / GB) * 100) / 100),
      ),
    };
  }
  return {
    policy: policyFieldsFromResponse(json),
    thresholdGb,
    targetMode: "percent",
    percent: String(
      Math.min(
        100,
        Math.max(1, Math.floor(json.target.removeOldestPercent ?? 25)),
      ),
    ),
    reduceGb: "4",
  };
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}
