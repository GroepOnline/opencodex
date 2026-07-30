/**
 * Opt-in Google Antigravity OAuth account pool.
 *
 * This is deliberately narrower than Codex routing. It keeps process-local session
 * affinity and rotates only after an explicit upstream 429 response.
 */
import { antigravitySessionId } from "../adapters/google-antigravity-wire";
import { fallbackCodexAccountLogLabel } from "../codex/account-label";
import {
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  notePoolRotationFailure,
  notePoolRotationSuccess,
  pickRoundRobinAccount,
  POOL_KEY_ANTIGRAVITY,
  seedPoolRotationAccount,
} from "../codex/pool-rotation";
import { getCachedProviderAccountQuota } from "../providers/quota";
import type {
  OcxAccountPoolRotationStrategy,
  OcxConfig,
  OcxParsedRequest,
} from "../types";
import { getAccountCredential, getAccountSet, setActiveAccount } from "./store";

const PROVIDER = "google-antigravity";
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
const MAX_AFFINITY_ENTRIES = 2_000;
const UNKNOWN_USAGE_SCORE = 100;
const DEFAULT_AUTO_SWITCH_THRESHOLD = 80;
const TOKEN_SKEW_MS = 60_000;

/** Cap same-request 429 rotations so short Retry-After values cannot loop forever. */
export const GOOGLE_ANTIGRAVITY_POOL_MAX_FAILOVERS_PER_REQUEST = 3;

export interface GoogleAntigravityAccountPoolConfig {
  enabled?: boolean;
  autoSwitchThreshold?: number;
  strategy?: OcxAccountPoolRotationStrategy;
  stickyLimit?: number;
}

interface AccountHealth {
  cooldownUntil: number;
  cooldownSource: "retry-after" | "default";
}

interface AffinityEntry {
  accountId: string;
  lastUsedAt: number;
}

export interface GoogleAntigravityAccountCredential {
  accessToken: string;
  projectId: string;
}

export type GoogleAntigravityAccountSelectionReason =
  | "pool-disabled"
  | "affinity"
  | "active"
  | "lowest-usage"
  | "only-eligible"
  | "round-robin"
  | "fill-first"
  | "none"
  | "all-cooled";

export interface GoogleAntigravityAccountSelection {
  accountId: string | null;
  reason: GoogleAntigravityAccountSelectionReason;
}

const upstreamHealth = new Map<string, AccountHealth>();
const sessionAffinity = new Map<string, AffinityEntry>();

export function googleAntigravityAccountPoolConfig(
  config: OcxConfig,
): GoogleAntigravityAccountPoolConfig {
  const raw = config.googleAntigravityAccountPool;
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

export function isGoogleAntigravityAccountPoolEnabled(config: OcxConfig): boolean {
  return googleAntigravityAccountPoolConfig(config).enabled === true;
}

export function googleAntigravityAutoSwitchThreshold(config: OcxConfig): number {
  const value = googleAntigravityAccountPoolConfig(config).autoSwitchThreshold;
  if (
    typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= 100
  ) {
    return value;
  }
  return DEFAULT_AUTO_SWITCH_THRESHOLD;
}

function poolStrategy(config: OcxConfig): OcxAccountPoolRotationStrategy {
  return normalizeAccountPoolStrategy(googleAntigravityAccountPoolConfig(config).strategy);
}

function stickyLimit(config: OcxConfig): number {
  return normalizeAccountPoolStickyLimit(
    googleAntigravityAccountPoolConfig(config).stickyLimit,
  );
}

function parseRetryAfterMs(
  value: string | null | undefined,
  now: number,
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.max(Math.ceil(seconds * 1_000), 1), MAX_COOLDOWN_MS);
    }
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? Math.min(delay, MAX_COOLDOWN_MS) : undefined;
}

export function getGoogleAntigravityAccountHealthSnapshot(
  accountId: string,
  now = Date.now(),
): { cooldownUntil?: number; cooldownSource?: AccountHealth["cooldownSource"] } | null {
  const entry = upstreamHealth.get(accountId);
  if (!entry) return null;
  if (entry.cooldownUntil <= now) {
    upstreamHealth.delete(accountId);
    return null;
  }
  return {
    cooldownUntil: entry.cooldownUntil,
    cooldownSource: entry.cooldownSource,
  };
}

export function clearGoogleAntigravityAccountCooldown(accountId: string): boolean {
  return upstreamHealth.delete(accountId);
}

/** Test and logout helper. */
export function clearGoogleAntigravityAccountPoolState(): void {
  upstreamHealth.clear();
  sessionAffinity.clear();
}

function isCooled(accountId: string, now: number): boolean {
  return getGoogleAntigravityAccountHealthSnapshot(accountId, now) !== null;
}

function credentialIsUsable(accountId: string, now: number): boolean {
  const credential = getAccountCredential(PROVIDER, accountId);
  if (!credential?.projectId?.trim()) return false;
  return Boolean(credential.refresh) || credential.expires > now + TOKEN_SKEW_MS;
}

export function getEligibleGoogleAntigravityAccounts(now = Date.now()): string[] {
  const set = getAccountSet(PROVIDER);
  if (!set) return [];
  return set.accounts
    .filter(account =>
      account.needsReauth !== true
      && !isCooled(account.id, now)
      && credentialIsUsable(account.id, now))
    .map(account => account.id);
}

export function getGoogleAntigravityPoolRetryAfterSeconds(
  now = Date.now(),
): number | null {
  const set = getAccountSet(PROVIDER);
  if (!set) return null;
  let earliest: number | null = null;
  for (const account of set.accounts) {
    const snapshot = getGoogleAntigravityAccountHealthSnapshot(account.id, now);
    if (!snapshot?.cooldownUntil) continue;
    if (earliest === null || snapshot.cooldownUntil < earliest) {
      earliest = snapshot.cooldownUntil;
    }
  }
  if (earliest === null || earliest <= now) return null;
  return Math.max(1, Math.ceil((earliest - now) / 1_000));
}

function usageScore(accountId: string): number {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  if (
    !quota
    || typeof quota.fiveHourPercent !== "number"
    || !Number.isFinite(quota.fiveHourPercent)
  ) {
    return UNKNOWN_USAGE_SCORE;
  }
  return Math.max(0, Math.min(100, quota.fiveHourPercent));
}

function hasKnownUsage(accountId: string): boolean {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  return typeof quota?.fiveHourPercent === "number"
    && Number.isFinite(quota.fiveHourPercent);
}

function pickLowestUsage(excludeId: string | undefined, now: number): string | null {
  const eligible = getEligibleGoogleAntigravityAccounts(now)
    .filter(accountId => accountId !== excludeId);
  if (eligible.length === 0) return null;
  let best = eligible[0]!;
  let bestScore = usageScore(best);
  for (let index = 1; index < eligible.length; index++) {
    const candidate = eligible[index]!;
    const score = usageScore(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function isUnderFillFirstThreshold(config: OcxConfig, accountId: string): boolean {
  const threshold = googleAntigravityAutoSwitchThreshold(config);
  if (threshold <= 0 || !hasKnownUsage(accountId)) return true;
  return usageScore(accountId) < threshold;
}

function pickNextFillFirstAccount(
  config: OcxConfig,
  afterId: string,
  eligible: string[],
): string | null {
  if (eligible.length === 0) return null;
  const ordered = [...eligible].sort((left, right) => left.localeCompare(right));
  const set = getAccountSet(PROVIDER);
  const stableAll = set
    ? set.accounts.map(account => account.id).sort((left, right) => left.localeCompare(right))
    : ordered;
  const startIndex = stableAll.indexOf(afterId);
  if (startIndex < 0) {
    return ordered.find(accountId => isUnderFillFirstThreshold(config, accountId))
      ?? ordered[0]
      ?? null;
  }
  let fallback: string | null = null;
  for (let step = 1; step <= stableAll.length; step++) {
    const candidate = stableAll[(startIndex + step) % stableAll.length]!;
    if (!eligible.includes(candidate)) continue;
    fallback ??= candidate;
    if (isUnderFillFirstThreshold(config, candidate)) return candidate;
  }
  return fallback ?? ordered[0] ?? null;
}

function pickFillFirstAccount(config: OcxConfig, now: number): string | null {
  const eligible = getEligibleGoogleAntigravityAccounts(now);
  if (eligible.length === 0) return null;
  const set = getAccountSet(PROVIDER);
  const active = set?.activeAccountId;
  if (active && eligible.includes(active) && isUnderFillFirstThreshold(config, active)) {
    return active;
  }
  if (!active) {
    const ordered = [...eligible].sort((left, right) => left.localeCompare(right));
    return ordered.find(accountId => isUnderFillFirstThreshold(config, accountId))
      ?? ordered[0]
      ?? null;
  }
  return pickNextFillFirstAccount(config, active, eligible);
}

function pickAlternateAccount(
  config: OcxConfig,
  failedAccountId: string,
  now: number,
): string | null {
  const eligible = getEligibleGoogleAntigravityAccounts(now)
    .filter(accountId => accountId !== failedAccountId);
  const strategy = poolStrategy(config);
  if (strategy === "round-robin") {
    return pickRoundRobinAccount(POOL_KEY_ANTIGRAVITY, eligible, stickyLimit(config));
  }
  if (strategy === "fill-first") {
    return pickNextFillFirstAccount(config, failedAccountId, eligible);
  }
  return pickLowestUsage(failedAccountId, now);
}

function pruneExpiredAffinity(now: number): void {
  for (const [key, entry] of sessionAffinity) {
    if (now - entry.lastUsedAt > AFFINITY_IDLE_TTL_MS) sessionAffinity.delete(key);
  }
  if (sessionAffinity.size <= MAX_AFFINITY_ENTRIES) return;
  const sorted = [...sessionAffinity.entries()]
    .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
  const drop = sessionAffinity.size - MAX_AFFINITY_ENTRIES;
  for (let index = 0; index < drop; index++) {
    sessionAffinity.delete(sorted[index]![0]);
  }
}

function bindAffinity(sessionKey: string, accountId: string, now: number): void {
  sessionAffinity.set(sessionKey, { accountId, lastUsedAt: now });
  pruneExpiredAffinity(now);
}

export function bindGoogleAntigravitySessionAffinity(
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  const key = sessionKey?.trim();
  if (key) bindAffinity(key, accountId, now);
}

export function clearGoogleAntigravitySessionAffinityForAccount(
  accountId: string,
): void {
  for (const [key, entry] of sessionAffinity) {
    if (entry.accountId === accountId) sessionAffinity.delete(key);
  }
}

/**
 * Drop a session's binding to `accountId`, leaving other sessions untouched and
 * ignoring a session that has already moved to a different account. Callers use
 * this when a rotation target turns out to be unusable, so the session is not
 * pinned to an account it can never authenticate with.
 */
export function releaseGoogleAntigravitySessionAffinity(
  sessionKey: string | null | undefined,
  accountId: string,
): void {
  const key = sessionKey?.trim();
  if (!key) return;
  if (sessionAffinity.get(key)?.accountId === accountId) sessionAffinity.delete(key);
}

export function googleAntigravitySessionKey(
  parsed: Pick<OcxParsedRequest, "context">,
): string {
  return antigravitySessionId(parsed);
}

export function resolveGoogleAntigravityAccountForSession(
  sessionKey: string | null | undefined,
  config: OcxConfig,
  now = Date.now(),
): GoogleAntigravityAccountSelection {
  pruneExpiredAffinity(now);
  const set = getAccountSet(PROVIDER);
  if (!set || set.accounts.length === 0) return { accountId: null, reason: "none" };
  if (!isGoogleAntigravityAccountPoolEnabled(config)) {
    return { accountId: set.activeAccountId, reason: "pool-disabled" };
  }

  const key = sessionKey?.trim() ?? "";
  const eligible = getEligibleGoogleAntigravityAccounts(now);
  if (key) {
    const affined = sessionAffinity.get(key);
    if (affined && eligible.includes(affined.accountId)) {
      affined.lastUsedAt = now;
      return { accountId: affined.accountId, reason: "affinity" };
    }
    sessionAffinity.delete(key);
  }

  const strategy = poolStrategy(config);
  const activeIsEligible = eligible.includes(set.activeAccountId);
  if (!key && activeIsEligible && strategy !== "quota") {
    return { accountId: set.activeAccountId, reason: "active" };
  }

  let accountId: string | null = null;
  let reason: GoogleAntigravityAccountSelectionReason = "none";
  if (strategy === "round-robin") {
    accountId = pickRoundRobinAccount(
      POOL_KEY_ANTIGRAVITY,
      eligible,
      stickyLimit(config),
    );
    if (accountId) {
      notePoolRotationSuccess(POOL_KEY_ANTIGRAVITY, accountId, stickyLimit(config));
      reason = "round-robin";
    }
  } else if (strategy === "fill-first") {
    accountId = pickFillFirstAccount(config, now);
    if (accountId) reason = "fill-first";
  } else {
    const threshold = googleAntigravityAutoSwitchThreshold(config);
    if (
      activeIsEligible
      && (
        threshold <= 0
        || !hasKnownUsage(set.activeAccountId)
        || usageScore(set.activeAccountId) < threshold
      )
    ) {
      accountId = set.activeAccountId;
      reason = "active";
    } else if (threshold > 0) {
      accountId = pickLowestUsage(undefined, now);
      if (accountId) {
        reason = accountId === set.activeAccountId ? "active" : "lowest-usage";
      }
    } else {
      accountId = pickLowestUsage(set.activeAccountId, now);
      if (accountId) reason = "only-eligible";
    }
  }

  if (!accountId) {
    const anyCooled = set.accounts.some(account => isCooled(account.id, now));
    return { accountId: null, reason: anyCooled ? "all-cooled" : "none" };
  }
  if (key) bindAffinity(key, accountId, now);
  return { accountId, reason };
}

/**
 * Cool a failed account and select the next eligible account. Callers invoke this
 * only for an explicit upstream 429 response.
 */
export function rotateGoogleAntigravityAccountOn429(
  config: OcxConfig,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  sessionKey?: string | null,
  now = Date.now(),
): string | null {
  if (!isGoogleAntigravityAccountPoolEnabled(config)) return null;
  const parsedRetryAfter = parseRetryAfterMs(retryAfterHeader, now);
  upstreamHealth.set(failedAccountId, {
    cooldownUntil: now + (parsedRetryAfter ?? DEFAULT_COOLDOWN_MS),
    cooldownSource: parsedRetryAfter ? "retry-after" : "default",
  });
  clearGoogleAntigravitySessionAffinityForAccount(failedAccountId);
  notePoolRotationFailure(POOL_KEY_ANTIGRAVITY, failedAccountId);

  const next = pickAlternateAccount(config, failedAccountId, now);
  if (!next) {
    console.warn("[google-antigravity-pool] all eligible accounts are in cooldown; returning 429");
    return null;
  }
  const key = sessionKey?.trim();
  if (key) bindAffinity(key, next, now);
  console.warn(
    `[google-antigravity-pool] 429 on ${formatGoogleAntigravityAccountOrdinal(failedAccountId)}; failing over to ${formatGoogleAntigravityAccountOrdinal(next)}`,
  );
  return next;
}

/**
 * Resolve the token and project from the same account. Refresh may update projectId,
 * so the credential is re-read after token resolution.
 */
export async function getGoogleAntigravityPoolCredential(
  accountId: string,
): Promise<GoogleAntigravityAccountCredential> {
  const { getValidAccessTokenForAccount, OAuthLoginRequiredError } = await import("./index");
  if (!getAccountCredential(PROVIDER, accountId)) {
    throw new OAuthLoginRequiredError(PROVIDER);
  }
  const accessToken = await getValidAccessTokenForAccount(PROVIDER, accountId);
  const projectId = getAccountCredential(PROVIDER, accountId)?.projectId?.trim();
  if (!projectId) {
    throw new Error(
      "Antigravity account has no Cloud Code Assist project id; re-run `ocx login google-antigravity`",
    );
  }
  return { accessToken, projectId };
}

export function promoteGoogleAntigravityActiveAccount(accountId: string): void {
  void setActiveAccount(PROVIDER, accountId).catch(() => { /* best-effort */ });
}

export function resetGoogleAntigravityRoutingForManualSelection(
  accountId: string,
): void {
  sessionAffinity.clear();
  seedPoolRotationAccount(POOL_KEY_ANTIGRAVITY, accountId);
}

export function formatGoogleAntigravityAccountOrdinal(accountId: string): string {
  return fallbackCodexAccountLogLabel(accountId);
}

export function formatGoogleAntigravityProviderForLog(
  accountId: string | null | undefined,
): string {
  if (!accountId) return PROVIDER;
  return `${PROVIDER}-${formatGoogleAntigravityAccountOrdinal(accountId)}`;
}
