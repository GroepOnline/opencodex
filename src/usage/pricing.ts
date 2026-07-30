/**
 * Estimated per-token pricing (EUR per 1,000 tokens).
 *
 * These are APPROXIMATIONS for budget alerting only — not billing. Prices change
 * frequently; treat numbers as conservative estimates. Unknown providers/models
 * default to 0 (free) so we never over-report spend for self-hosted/gateway routes.
 *
 * Source: provider pricing pages as of mid-2025, converted to EUR (~1 USD = 0.92 EUR).
 */
export interface ProviderPricing {
  /** EUR per 1k input tokens (uncached). */
  inputPer1k: number;
  /** EUR per 1k output tokens. */
  outputPer1k: number;
}

/**
 * Keyed by provider id (matches PROVIDER_REGISTRY ids) OR "provider:model" for
 * model-specific overrides. Lookups try model-specific first, then provider, then 0.
 */
const PRICING: Record<string, ProviderPricing> = {
  // OpenAI (flagship tiers; mini/flash much cheaper but we default conservatively)
  "openai:gpt-4o": { inputPer1k: 0.0023, outputPer1k: 0.0092 },
  "openai:chatgpt-4o-latest": { inputPer1k: 0.0051, outputPer1k: 0.0152 },
  "openai:gpt-4o-mini": { inputPer1k: 0.00013, outputPer1k: 0.00052 },
  "openai": { inputPer1k: 0.0023, outputPer1k: 0.0092 },

  // Anthropic (Claude)
  "anthropic:claude-sonnet-4-5": { inputPer1k: 0.0028, outputPer1k: 0.0139 },
  "anthropic:claude-opus-4": { inputPer1k: 0.0139, outputPer1k: 0.0694 },
  "anthropic:claude-haiku-4-5": { inputPer1k: 0.00092, outputPer1k: 0.0046 },
  "anthropic": { inputPer1k: 0.0028, outputPer1k: 0.0139 },

  // Google Gemini
  "google:gemini-2.5-pro": { inputPer1k: 0.00115, outputPer1k: 0.0046 },
  "google:gemini-2.5-flash": { inputPer1k: 0.00012, outputPer1k: 0.00037 },
  "google": { inputPer1k: 0.00031, outputPer1k: 0.00092 },

  // xAI Grok
  "xai:grok-4": { inputPer1k: 0.0028, outputPer1k: 0.0139 },
  "xai": { inputPer1k: 0.0046, outputPer1k: 0.0139 },

  // DeepSeek
  "deepseek:deepseek-chat": { inputPer1k: 0.00023, outputPer1k: 0.00083 },
  "deepseek": { inputPer1k: 0.00023, outputPer1k: 0.00083 },

  // Kimi / Moonshot
  "kimi": { inputPer1k: 0.00046, outputPer1k: 0.0028 },
  "moonshot": { inputPer1k: 0.00046, outputPer1k: 0.0028 },

  // Z.AI (GLM) — coding plan, flat-rate, estimate as low
  "zai": { inputPer1k: 0, outputPer1k: 0 },

  // Cursor — subscription, estimate as 0 (covered by sub)
  "cursor": { inputPer1k: 0, outputPer1k: 0 },

  // OmniRoute — free tier
  "omniroute": { inputPer1k: 0, outputPer1k: 0 },

  // Ollama / self-hosted — free
  "ollama-cloud": { inputPer1k: 0, outputPer1k: 0 },
  "litellm": { inputPer1k: 0, outputPer1k: 0 },

  // Kiro — subscription
  "kiro": { inputPer1k: 0, outputPer1k: 0 },

  // GitHub Copilot — subscription
  "github-copilot": { inputPer1k: 0, outputPer1k: 0 },
};

/** Find the best-matching pricing entry: model-specific, then provider, then free. */
export function lookupPricing(provider: string, model?: string): ProviderPricing {
  if (model) {
    const modelKey = `${provider}:${model.toLowerCase()}`;
    if (PRICING[modelKey]) return PRICING[modelKey];
    // Try a prefix match (e.g. "claude-sonnet-4-5-20250929" → "claude-sonnet-4-5")
    const prefixHit = Object.keys(PRICING).find((k) => {
      if (!k.startsWith(`${provider}:`)) return false;
      const baseModel = k.slice(provider.length + 1);
      return baseModel !== provider && model.toLowerCase().startsWith(baseModel);
    });
    if (prefixHit) return PRICING[prefixHit];
  }
  return PRICING[provider] ?? { inputPer1k: 0, outputPer1k: 0 };
}

/** Estimate EUR cost for a usage record. */
export function estimateCostEur(
  provider: string,
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = lookupPricing(provider, model);
  return (inputTokens / 1000) * p.inputPer1k + (outputTokens / 1000) * p.outputPer1k;
}
