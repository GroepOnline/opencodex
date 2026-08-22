import { recordProviderCapCooldown, type ProviderCapCooldown } from "../providers/cap-cooldown";
import { activateUncooledApiKey, hasKeyPoolFailover, rotateProviderTransportOn429 } from "../providers/key-failover";
import type { OcxConfig, OcxProviderConfig } from "../types";
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
export function selectKeyPoolCandidate(input: {
  config: OcxConfig;
  providerName: string;
  routedProvider: OcxProviderTransport;
  promptCacheKey?: string;
  now?: number;
}): OcxProviderTransport | null {
  const selected = activateUncooledApiKey(
    input.config,
    input.providerName,
    input.now,
    input.routedProvider.apiKey,
  );
  if (!selected) return null;
  return resolveProviderTransport(
    input.providerName,
    { ...input.routedProvider, apiKey: selected.apiKey },
    input.promptCacheKey,
  );
}

/**
 * Record a key-pool outcome and return the next fetch-ready provider, or null to surface.
 * Combo/Codex hops still go through their own loops; this is the apiKeyPool adapter.
 */
export function resolveOutcome(input: ResolveOutcomeInput): OcxProviderTransport | null {
  recordCapOutcome(input);
  // Hard-cap 402 responses must cool the failed pooled key too; provider-level
  // cooldown recording is intentionally suppressed for key pools.
  if (!isAccountPoolHopStatus(input.status) && input.status !== 402) return null;
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
