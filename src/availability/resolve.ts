import { isHardCapMessage, recordProviderCapCooldown, type ProviderCapCooldown } from "../providers/cap-cooldown";
import { coolAttemptedKey, hasKeyPoolFailover, pickUncooledApiKey, rotateProviderTransportOn429 } from "../providers/key-failover";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { resolveEnvValue, saveConfigPreservingClaudeCode } from "../config";
import type { OcxProviderTransport } from "../providers/xai-transport";
import { isAccountPoolHopStatus } from "./classify";

export type ResolveOutcomeInput = {
  config: OcxConfig;
  /** Live server config for disk writes when `config` is a routing clone (fallback chain). */
  persistConfig?: OcxConfig;
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

function capPersistSave(
  input: Pick<ResolveOutcomeInput, "config" | "persistConfig" | "save">,
): boolean | ((config: OcxConfig) => void) {
  if (input.save === false) return false;
  if (typeof input.save === "function") return input.save;
  const root = input.persistConfig ?? input.config;
  return () => saveConfigPreservingClaudeCode(root);
}

/** Persist a hard weekly/inference cap on this provider. Key pools no-op unless every key is cooling. */
export function recordCapOutcome(input: {
  config: OcxConfig;
  persistConfig?: OcxConfig;
  providerName: string;
  status: number;
  message?: string;
  now?: number;
  save?: boolean | ((config: OcxConfig) => void);
  allowPooled?: boolean;
}): ProviderCapCooldown | null {
  try {
    return recordProviderCapCooldown(input.config, input.providerName, input.status, input.message, {
      now: input.now,
      save: capPersistSave(input),
      ...(input.allowPooled !== undefined ? { allowPooled: input.allowPooled } : {}),
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
  | { kind: "selected"; apiKey: string }
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
  if (!apiKey) return { kind: "live" };
  return { kind: "selected", apiKey };
}

function pausePooledProviderIfHardCapped(input: ResolveOutcomeInput): void {
  if (!isHardCapMessage(input.status, input.message)) return;
  recordCapOutcome({ ...input, allowPooled: true });
}

/**
 * Record a key-pool outcome and return the next fetch-ready provider, or null to surface.
 * Combo/Codex hops still go through their own loops; this is the apiKeyPool adapter.
 */
export function resolveOutcome(input: ResolveOutcomeInput): OcxProviderTransport | null {
  if (hasKeyPoolFailover(input.routedProvider)) {
    if (isAccountPoolHopStatus(input.status)) {
      const rotated = rotateProviderTransportOn429(
        input.config,
        input.providerName,
        input.routedProvider,
        {
          retryAfter: input.retryAfter,
          now: input.now,
          attemptedKey: input.attemptedKey,
          promptCacheKey: input.promptCacheKey,
          message: input.message,
          status: input.status,
          persistConfig: input.persistConfig,
        },
      );
      if (rotated) return rotated;
      pausePooledProviderIfHardCapped(input);
      return null;
    }
    if (input.status === 402) {
      const allCooled = coolAttemptedKey(input.config, input.providerName, {
        retryAfter: input.retryAfter,
        now: input.now,
        attemptedKey: input.attemptedKey,
        message: input.message,
        status: input.status,
        persistConfig: input.persistConfig,
      });
      if (allCooled) pausePooledProviderIfHardCapped(input);
      return null;
    }
    recordCapOutcome(input);
    return null;
  }
  recordCapOutcome(input);
  return null;
}
