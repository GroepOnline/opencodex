/**
 * Additive provider wire-compat metadata (Pi-inspired).
 *
 * Existing registry lists (`thinkingToggleModels`, `thinkingBudgetModels`,
 * `promptCacheKey`, …) remain authoritative when present. `compat` fills gaps
 * for OpenAI-compatible gateways (OmniRoute, custom proxies) without ripping
 * those lists out.
 */

/** How reasoning/thinking is encoded on the chat-completions wire. */
export type ThinkingFormat =
  | "openai" // `reasoning_effort`
  | "openrouter" // `reasoning: { effort }`
  | "thinking-type" // `thinking: { type: enabled|disabled|adaptive }`
  | "qwen" // `enable_thinking: boolean`
  | "thinking-budget"; // `thinking_budget: number`

/** Chat-completions max-output field name. */
export type MaxTokensField = "max_tokens" | "max_completion_tokens";

/**
 * Session stickiness hint for OpenAI-compatible gateways.
 * Orthogonal to OCX OAuth account-pool affinity (Codex/Anthropic/Antigravity/Cursor).
 */
export type SessionAffinityFormat = "none" | "prompt-cache-key" | "x-session-id";

export interface ProviderCompat {
  thinkingFormat?: ThinkingFormat;
  sessionAffinity?: SessionAffinityFormat;
  /** When true, prefer `strict: true` on tools that omit an explicit strict bit. */
  supportsStrictMode?: boolean;
  maxTokensField?: MaxTokensField;
}

export const DEFAULT_PROVIDER_COMPAT: Readonly<Required<ProviderCompat>> = {
  thinkingFormat: "openai",
  sessionAffinity: "none",
  supportsStrictMode: false,
  maxTokensField: "max_tokens",
};

/** OmniRoute self-host loopback defaults (REQUIRE_API_KEY=false accepts this bearer). */
export const OMNIROUTE_LOOPBACK_BASE_URL = "http://127.0.0.1:20128/v1";
export const OMNIROUTE_PLACEHOLDER_API_KEY = "sk_omniroute";

/** Live liveness path on diegosouzapw/omniroute (plain 200); `/health` is a Next 404. */
export const OMNIROUTE_HEALTH_PATH = "/healthz";

/**
 * Exact Docker run for ops (loopback-only bind). Documented for smoke when Docker
 * is unavailable in CI/dev worktrees:
 *
 * docker run -d --name omniroute \
 *   -e REQUIRE_API_KEY=false \
 *   -p 127.0.0.1:20128:20128 \
 *   diegosouzapw/omniroute
 */
export const OMNIROUTE_DOCKER_RUN = [
  "docker run -d --name omniroute",
  "-e REQUIRE_API_KEY=false",
  "-p 127.0.0.1:20128:20128",
  "diegosouzapw/omniroute",
].join(" \\\n  ");

export function resolveProviderCompat(
  compat: ProviderCompat | undefined,
): Required<ProviderCompat> {
  return {
    thinkingFormat: compat?.thinkingFormat ?? DEFAULT_PROVIDER_COMPAT.thinkingFormat,
    sessionAffinity: compat?.sessionAffinity ?? DEFAULT_PROVIDER_COMPAT.sessionAffinity,
    supportsStrictMode: compat?.supportsStrictMode ?? DEFAULT_PROVIDER_COMPAT.supportsStrictMode,
    maxTokensField: compat?.maxTokensField ?? DEFAULT_PROVIDER_COMPAT.maxTokensField,
  };
}

export function cloneProviderCompat(compat: ProviderCompat | undefined): ProviderCompat | undefined {
  if (!compat) return undefined;
  const out: ProviderCompat = {};
  if (compat.thinkingFormat !== undefined) out.thinkingFormat = compat.thinkingFormat;
  if (compat.sessionAffinity !== undefined) out.sessionAffinity = compat.sessionAffinity;
  if (compat.supportsStrictMode !== undefined) out.supportsStrictMode = compat.supportsStrictMode;
  if (compat.maxTokensField !== undefined) out.maxTokensField = compat.maxTokensField;
  return out;
}
