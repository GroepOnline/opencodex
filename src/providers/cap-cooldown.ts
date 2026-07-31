/**
 * Provider-level weekly/inference-cap cooldowns.
 *
 * When upstream returns a hard weekly/inference cap (e.g. Clinepass INFERENCE_CAP_ERROR
 * with "resets in Nd Nh"), we persist a cooldown on the provider, optionally disable it,
 * and surface the message in the GUI via /api/config.providerCooldowns.
 */
import { loadConfig, saveConfigPreservingClaudeCode } from "../config";
import type { OcxConfig } from "../types";

export interface ProviderCapCooldown {
  until: number;
  reason: string;
  message: string;
  source: string;
  disabledProvider?: boolean;
  recordedAt?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/** Parse "resets in 1d 22h" / "resets in 2d" / "resets in 3h" style phrases. */
export function parseResetsInMs(message: string, now = Date.now()): number | undefined {
  const text = message.replace(/\s+/g, " ");
  const m = text.match(/resets?\s+in\s+(?:(\d+)\s*d(?:ays?)?)?(?:\s*)?(?:(\d+)\s*h(?:ours?)?)?(?:\s*)?(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (!m) return undefined;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const mins = Number(m[3] || 0);
  if (!Number.isFinite(days) || !Number.isFinite(hours) || !Number.isFinite(mins)) return undefined;
  if (days === 0 && hours === 0 && mins === 0) return undefined;
  return now + days * DAY_MS + hours * HOUR_MS + mins * MIN_MS;
}

export function isHardCapMessage(status: number, upstreamError?: string): boolean {
  if (status !== 429 && status !== 402) return false;
  const text = (upstreamError || "").toLowerCase();
  return (
    text.includes("inference_cap")
    || text.includes("weekly") && (text.includes("limit") || text.includes("cap"))
    || text.includes("usage limit")
    || text.includes("package has expired")
    || text.includes("out of usage")
  );
}

export function activeProviderCooldowns(
  config: OcxConfig,
  now = Date.now(),
): Record<string, ProviderCapCooldown> {
  const raw = (config as OcxConfig & { providerCooldowns?: Record<string, ProviderCapCooldown> }).providerCooldowns;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ProviderCapCooldown> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry.until !== "number" || !Number.isFinite(entry.until)) continue;
    if (entry.until <= now) continue;
    out[name] = entry;
  }
  return out;
}

/**
 * Expire stale cooldowns. Re-enables providers we auto-disabled when the window ends.
 * Returns true when config was mutated.
 */
export function expireProviderCooldowns(config: OcxConfig, now = Date.now()): boolean {
  const bag = (config as OcxConfig & { providerCooldowns?: Record<string, ProviderCapCooldown> }).providerCooldowns;
  if (!bag) return false;
  let changed = false;
  for (const [name, entry] of Object.entries(bag)) {
    if (!entry || typeof entry.until !== "number" || entry.until > now) continue;
    delete bag[name];
    changed = true;
    if (entry.disabledProvider && config.providers[name]?.disabled === true) {
      delete config.providers[name].disabled;
    }
  }
  if (Object.keys(bag).length === 0) {
    delete (config as OcxConfig & { providerCooldowns?: unknown }).providerCooldowns;
  }
  return changed;
}

/** Record a hard-cap 429 onto the provider and optionally disable it until reset. */
export function recordProviderCapCooldown(
  providerName: string,
  status: number,
  upstreamError: string | undefined,
  opts?: { disable?: boolean; now?: number },
): ProviderCapCooldown | null {
  if (!providerName || !isHardCapMessage(status, upstreamError)) return null;
  const now = opts?.now ?? Date.now();
  const message = (upstreamError || "Usage limit reached").slice(0, 400);
  const until = parseResetsInMs(message, now) ?? (now + DAY_MS); // default 24h if unparsed
  const reason = /inference_cap/i.test(message)
    ? "INFERENCE_CAP_ERROR"
    : /weekly/i.test(message)
      ? "weekly_usage_limit"
      : "usage_cap";

  const config = loadConfig();
  expireProviderCooldowns(config, now);
  const bag = ((config as OcxConfig & { providerCooldowns?: Record<string, ProviderCapCooldown> }).providerCooldowns
    ??= {});
  const prev = bag[providerName];
  // Don't shorten an existing longer cooldown.
  if (prev && prev.until > until) return prev;

  const disable = opts?.disable !== false; // default: temporarily disable
  const entry: ProviderCapCooldown = {
    until,
    reason,
    message,
    source: "upstream-429",
    disabledProvider: disable,
    recordedAt: now,
  };
  bag[providerName] = entry;
  if (disable && config.providers[providerName] && config.defaultProvider !== providerName) {
    config.providers[providerName].disabled = true;
  }
  saveConfigPreservingClaudeCode(config);
  console.warn(
    `[opencodex] Provider cap cooldown set provider=${providerName} until=${new Date(until).toISOString()} reason=${reason}`,
  );
  return entry;
}
