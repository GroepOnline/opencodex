/**
 * Provider-level weekly/inference-cap cooldowns.
 *
 * When upstream returns a hard weekly/inference cap (e.g. Clinepass INFERENCE_CAP_ERROR
 * with "resets in Nd Nh"), we persist a cooldown on the LIVE server config, optionally
 * disable the provider, and surface a short summary via /api/config.providerCooldowns.
 *
 * Availability records this from the Responses turn (`recordCapOutcome` /
 * `resolveOutcome`). Key-pooled providers rotate keys instead of pausing, until
 * every key is cooling after a hard cap — then a provider-level window is recorded
 * so combo/fallback selection stops choosing the exhausted provider.
 * Callers must pass the live `OcxConfig` instance owned by `startServer` — never a fresh
 * `loadConfig()` snapshot — so routing and management see the change immediately.
 */
import { saveConfigPreservingClaudeCode } from "../config";
import type { OcxConfig, ProviderCapCooldown } from "../types";
import { hasKeyPoolFailover } from "./api-keys";
import { expireKeyPoolCooldowns } from "./key-failover";
import { isAnthropicAccountPoolEnabled } from "../oauth/anthropic-routing";
import { isCursorAccountPoolEnabled } from "../oauth/cursor-routing";
import { isGoogleAntigravityAccountPoolEnabled } from "../oauth/google-antigravity-routing";
import { OAUTH_PROVIDERS } from "../oauth";

export type { ProviderCapCooldown };

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/** A recomputed window must exceed the active one by more than this to replace it. */
const COOLDOWN_EXTEND_TOLERANCE_MS = HOUR_MS;
/** How often the live server sweeps expired cooldowns back off `providers[].disabled`. */
const DEFAULT_SWEEP_MS = 60 * 1000;

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

/**
 * Strong hard-cap signal only: INFERENCE_CAP / weekly+limit with a parseable reset,
 * or explicit package-expired / out-of-usage phrases. Bare "usage limit" 429s are ignored
 * so temporary rate limits do not auto-disable a provider for 24h.
 */
export function isHardCapMessage(status: number, upstreamError?: string): boolean {
  if (status !== 429 && status !== 402) return false;
  const text = (upstreamError || "").toLowerCase();
  if (text.includes("inference_cap")) return true;
  if (text.includes("package has expired") || text.includes("out of usage")) return true;
  const weekly = text.includes("weekly") && (text.includes("limit") || text.includes("cap"));
  if (weekly && parseResetsInMs(upstreamError || "") !== undefined) return true;
  return false;
}

/** Map log labels like `openai-work` back to a config.providers key. */
export function resolveProviderConfigKey(config: OcxConfig, logProvider: string): string | null {
  if (!logProvider || logProvider === "combo") return null;
  // Own-property only: `providers` is a plain record, so a log label like `constructor` or
  // `toString` would otherwise resolve to an inherited function and be treated as a provider.
  if (Object.hasOwn(config.providers, logProvider)) return logProvider;
  const names = Object.keys(config.providers).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (logProvider.startsWith(`${name}-`)) return name;
  }
  return null;
}

export function activeProviderCooldowns(
  config: OcxConfig,
  now = Date.now(),
): Record<string, ProviderCapCooldown> {
  const raw = config.providerCooldowns;
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
 * Expire stale cooldowns. Re-enables providers this path auto-disabled when the window ends.
 * Returns true when config was mutated.
 */
export function expireProviderCooldowns(config: OcxConfig, now = Date.now()): boolean {
  const bag = config.providerCooldowns;
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
  if (changed && Object.keys(bag).length === 0) {
    delete config.providerCooldowns;
  }
  return changed;
}

/**
 * Expire provider-level and per-key persisted windows. Always runs both
 * sweeps: `expireProviderCooldowns(config) || expireKeyPoolCooldowns(config)`
 * would skip the key-pool bag whenever a provider window already expired.
 */
export function expireRecordedCooldowns(config: OcxConfig, now = Date.now()): boolean {
  const expiredProvider = expireProviderCooldowns(config, now);
  const expiredKeys = expireKeyPoolCooldowns(config, now);
  return expiredProvider || expiredKeys;
}

/**
 * Hand ownership of `providers[name].disabled` back to the operator.
 *
 * `expireProviderCooldowns` only re-enables providers this module disabled, which it tracks
 * via `disabledProvider`. Once a human toggles `disabled` through the management API that
 * flag is a lie: leaving it set lets the expiry sweep silently re-enable a provider the
 * operator deliberately turned off. Returns true when the flag was cleared.
 */
export function releaseProviderCooldownDisableOwnership(config: OcxConfig, providerName: string): boolean {
  const entry = config.providerCooldowns?.[providerName];
  if (!entry || entry.disabledProvider !== true) return false;
  entry.disabledProvider = false;
  return true;
}

/**
 * Drop the cooldown recorded for a provider that is being deleted or replaced wholesale.
 *
 * Cooldown entries are keyed by provider name only, so after a delete or a POST overwrite
 * the entry would claim disable-ownership over an unrelated provider instance: expiry would
 * then strip an operator's explicit `disabled: true` from the replacement. The window
 * belonged to the old configuration (and its credentials), so it dies with it.
 * Returns true when config was mutated.
 */
export function clearProviderCapCooldown(config: OcxConfig, providerName: string): boolean {
  const bag = config.providerCooldowns;
  if (!bag || !Object.hasOwn(bag, providerName)) return false;
  delete bag[providerName];
  if (Object.keys(bag).length === 0) delete config.providerCooldowns;
  return true;
}

export interface ProviderCooldownSweep {
  stop: () => void;
}

/** The single in-flight sweep, so repeated `startServer` calls cannot stack timers. */
let activeSweep: ProviderCooldownSweep | null = null;

/**
 * Periodically expire cooldowns on the live config.
 *
 * Routing reads `providers[name].disabled` directly (see `server/responses/core.ts`,
 * `combos/resolve.ts`, `codex/subagent-model-fallback.ts`), and expiry otherwise only runs
 * at startup and on `GET /api/config`. A headless proxy — the primary mode, driving Codex
 * CLI or Claude Code with no dashboard open — would therefore keep an auto-paused provider
 * disabled indefinitely past its reset. This sweep is that auto-recovery.
 */
export function startProviderCooldownSweep(
  config: OcxConfig,
  opts?: { intervalMs?: number; save?: (config: OcxConfig) => void },
): ProviderCooldownSweep {
  // One live config means one sweep: replace any prior timer instead of stacking them.
  activeSweep?.stop();
  const save = opts?.save ?? saveConfigPreservingClaudeCode;
  const timer = setInterval(() => {
    try {
      if (expireRecordedCooldowns(config)) save(config);
    } catch {
      /* best-effort: a failed sweep must never take the proxy down */
    }
  }, opts?.intervalMs ?? DEFAULT_SWEEP_MS);
  // Never hold the process open on this alone.
  (timer as { unref?: () => void }).unref?.();
  const sweep: ProviderCooldownSweep = {
    stop: () => {
      clearInterval(timer);
      if (activeSweep === sweep) activeSweep = null;
    },
  };
  activeSweep = sweep;
  return sweep;
}

export interface RecordProviderCapCooldownOpts {
  disable?: boolean;
  now?: number;
  /**
   * Persistence for a newly recorded window: `false` skips it, a function replaces
   * `saveConfigPreservingClaudeCode` (tests count real writes), default persists to disk.
   */
  save?: boolean | ((config: OcxConfig) => void);
  /**
   * Record a provider-level window even when the provider has an apiKeyPool.
   * Used once every pooled key is already cooling after a hard cap, so combo/fallback
   * selection (which keys off `providers[name].disabled`) stops choosing it.
   */
  allowPooled?: boolean;
}

/**
 * True when this provider routes through a multi-account OAuth pool whose per-account
 * rotation owns account-scoped cap handling. A cap message from one pooled account must not
 * hard-disable the whole provider while other accounts still have capacity.
 */
function hasOauthAccountPoolFailover(config: OcxConfig, key: string): boolean {
  // Consult the canonical OAuth registry and actual provider routing before suppressing cooldowns.
  if (!OAUTH_PROVIDERS[key] || config.providers[key]?.authMode !== "oauth") return false;
  if (key === "anthropic") return isAnthropicAccountPoolEnabled(config);
  if (key === "google-antigravity") return isGoogleAntigravityAccountPoolEnabled(config);
  if (key === "cursor") return isCursorAccountPoolEnabled(config);
  return false;
}

/** Record a hard-cap 429/402 onto the live provider config and optionally disable until reset. */
export function recordProviderCapCooldown(
  config: OcxConfig,
  providerName: string,
  status: number,
  upstreamError: string | undefined,
  opts?: RecordProviderCapCooldownOpts,
): ProviderCapCooldown | null {
  const key = resolveProviderConfigKey(config, providerName);
  if (!key || !isHardCapMessage(status, upstreamError)) return null;
  const pooled = config.providers[key];
  if (
    pooled
    && (hasKeyPoolFailover(pooled)
      || (hasOauthAccountPoolFailover(config, key) && (status === 429 || status === 402)))
    && opts?.allowPooled !== true
  ) return null;
  const now = opts?.now ?? Date.now();
  const rawMessage = (upstreamError || "Usage limit reached").slice(0, 400);
  const until = parseResetsInMs(rawMessage, now);
  if (until === undefined && !/inference_cap/i.test(rawMessage)
    && !/package has expired/i.test(rawMessage)
    && !/out of usage/i.test(rawMessage)) {
    // Weekly phrases without a parseable reset are not strong enough to auto-pause.
    return null;
  }
  const untilMs = until ?? (now + DAY_MS);
  const reason = /inference_cap/i.test(rawMessage)
    ? "INFERENCE_CAP_ERROR"
    : /weekly/i.test(rawMessage)
      ? "weekly_usage_limit"
      : "usage_cap";
  // Short GUI-safe summary — avoid echoing long upstream bodies (emails, org ids).
  const message = reason === "INFERENCE_CAP_ERROR"
    ? "Weekly inference cap reached."
    : reason === "weekly_usage_limit"
      ? "Weekly usage limit reached."
      : "Usage cap reached.";

  expireProviderCooldowns(config, now);
  const bag = (config.providerCooldowns ??= {});
  const prev = bag[key];
  // An already-active cooldown is authoritative. Clients retry hard, so this runs once per
  // rejected request; rewriting `until` each time would fsync config.json on the request
  // finalization path for the whole cap window. Upstream countdowns ("resets in 1d 22h") are
  // hour-quantized, so a recomputed window drifts later by up to an hour without meaning
  // anything — only a materially longer window (a 24h cap escalating to weekly) replaces it.
  if (prev && prev.until + COOLDOWN_EXTEND_TOLERANCE_MS >= untilMs) return prev;

  const wantDisable = opts?.disable !== false;
  const didDisable = wantDisable
    && !!config.providers[key]
    && config.defaultProvider !== key
    && config.providers[key].disabled !== true;

  if (didDisable) {
    config.providers[key].disabled = true;
  }

  const entry: ProviderCapCooldown = {
    until: untilMs,
    reason,
    message: `${message} Resets ~${new Date(untilMs).toISOString()}.`,
    source: status === 402 ? "upstream-402" : "upstream-429",
    disabledProvider: didDisable || (prev?.disabledProvider === true && config.providers[key]?.disabled === true),
    recordedAt: now,
  };
  bag[key] = entry;
  if (opts?.save !== false) {
    const save = typeof opts?.save === "function" ? opts.save : saveConfigPreservingClaudeCode;
    save(config);
  }
  console.warn(
    `[opencodex] Provider cap cooldown set provider=${key} until=${new Date(untilMs).toISOString()} reason=${reason} disabled=${!!entry.disabledProvider}`,
  );
  return entry;
}
