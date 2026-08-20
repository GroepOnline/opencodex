import { recordProviderCapCooldown, type ProviderCapCooldown } from "../providers/cap-cooldown";
import { hasKeyPoolFailover, pickUncooledApiKey, rotateProviderTransportOn429 } from "../providers/key-failover";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { resolveEnvValue } from "../config";
import { resolveProviderTransport, type OcxProviderTransport } from "../providers/xai-transport";
import { isAccountPoolHopStatus } from "./classify";

export type ResolveOutcomeInput = {
  config: OcxConfig;
  providerName: string;
  routedProvider: OcxProviderTransport;
  status: number;
  retryAfter?: string | null;
  attemptedKey?: string;
  promptCacheKey?: string;
  now?: number;
  message?: string;
  save?: boolean | ((config: OcxConfig) => void);
};

/** Persist a hard weekly/inference cap on this provider. Key pools no-op (cool the key instead). */
export function recordCapOutcome(input: {
  config: OcxConfig;
  providerName: string;
  status: number;
  message?: string;
  now?: number;
  save?: boolean | ((config: OcxConfig) => void);
}): ProviderCapCooldown | null {
  try {
    return recordProviderCapCooldown(input.config, input.providerName, input.status, input.message, {
      now: input.now,
      ...(input.save !== undefined ? { save: input.save } : {}),
    });
  } catch {
    console.warn("[opencodex] Failed to persist provider cap cooldown");
    return null;
  }
}

/** True when this provider has a key pool that Availability may hop. Does not read the body. */
export function keyPoolCanHop(provider: OcxProviderConfig | OcxProviderTransport): boolean {
  return hasKeyPoolFailover(provider);
}

/**
 * First key-pool pick. Skips a cooling active key so Meta/Zen-style openai-chat
 * pools do not spend a turn on a credential that already 429'd.
 */
export type KeyPoolCandidateResult =
  | { kind: "live" }
  | { kind: "selected"; transport: OcxProviderTransport }
  | { kind: "all-cooled"; retryAfterSeconds: number };

export function selectKeyPoolCandidate(input: {
  config: OcxConfig;
  providerName: string;
  routedProvider: OcxProviderTransport;
  promptCacheKey?: string;
  now?: number;
}): KeyPoolCandidateResult {
  const pick = pickUncooledApiKey(
    input.config,
    input.providerName,
    input.now,
    input.routedProvider.apiKey,
  );
  if (pick.kind === "noop") return { kind: "live" };
  if (pick.kind === "all-cooled") {
    return { kind: "all-cooled", retryAfterSeconds: pick.retryAfterSeconds };
  }
  const apiKey = resolveEnvValue(pick.provider.apiKey) ?? pick.provider.apiKey;
  return {
    kind: "selected",
    transport: resolveProviderTransport(
      input.providerName,
      { ...input.routedProvider, apiKey },
      input.promptCacheKey,
    ),
  };
}

/**
 * Record a key-pool outcome and return the next fetch-ready provider, or null to surface.
 * Combo/Codex hops still go through their own loops; this is the apiKeyPool adapter.
 */
export function resolveOutcome(input: ResolveOutcomeInput): OcxProviderTransport | null {
  recordCapOutcome(input);
  if (!isAccountPoolHopStatus(input.status)) return null;
  if (!hasKeyPoolFailover(input.routedProvider)) return null;
  return rotateProviderTransportOn429(
    input.config,
    input.providerName,
    input.routedProvider,
    {
      retryAfter: input.retryAfter,
      now: input.now,
      attemptedKey: input.attemptedKey,
      promptCacheKey: input.promptCacheKey,
      message: input.message,
    },
  );
}
