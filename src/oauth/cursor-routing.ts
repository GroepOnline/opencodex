/**
 * Opt-in Cursor OAuth account pool.
 *
 * Affinity and cooldowns are process-local. Rotation is deliberately reactive:
 * callers may invoke rotateCursorAccountOnQuota only for an explicit, pre-output
 * 429, RESOURCE_EXHAUSTED, or hard-quota failure.
 */
import { createHash } from "node:crypto";
import { fallbackCodexAccountLogLabel } from "../codex/account-label";
import {
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  notePoolRotationFailure,
  notePoolRotationSuccess,
  pickRoundRobinAccount,
  POOL_KEY_CURSOR,
  seedPoolRotationAccount,
} from "../codex/pool-rotation";
import { classifyCursorUpstreamOutcome } from "../lib/upstream-outcome";
import { getCachedProviderAccountQuota } from "../providers/quota";
import type { OcxAccountPoolRotationStrategy, OcxConfig } from "../types";
import { getAccountCredential, getAccountSet, setActiveAccount } from "./store";

const PROVIDER = "cursor";
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
const MAX_AFFINITY_ENTRIES = 2_000;
const DEFAULT_AUTO_SWITCH_THRESHOLD = 80;
const UNKNOWN_USAGE_SCORE = 100;
const TOKEN_SKEW_MS = 60_000;

export const CURSOR_POOL_MAX_FAILOVERS_PER_REQUEST = 3;

export interface CursorAccountPoolConfig {
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

export type CursorAccountSelectionReason =
  | "pool-disabled"
  | "affinity"
  | "active"
  | "lowest-usage"
  | "only-eligible"
  | "round-robin"
  | "fill-first"
  | "none"
  | "all-cooled";

export interface CursorAccountSelection {
  accountId: string | null;
  reason: CursorAccountSelectionReason;
}

const upstreamHealth = new Map<string, AccountHealth>();
const sessionAffinity = new Map<string, AffinityEntry>();

export function cursorAccountPoolConfig(config: OcxConfig): CursorAccountPoolConfig {
  const raw = config.cursorAccountPool;
  return raw && typeof raw === "object" ? raw : {};
}

export function isCursorAccountPoolEnabled(config: OcxConfig): boolean {
  return cursorAccountPoolConfig(config).enabled === true;
}

export function cursorAutoSwitchThreshold(config: OcxConfig): number {
  const value = cursorAccountPoolConfig(config).autoSwitchThreshold;
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= 100
    ? value
    : DEFAULT_AUTO_SWITCH_THRESHOLD;
}

function poolStrategy(config: OcxConfig): OcxAccountPoolRotationStrategy {
  return normalizeAccountPoolStrategy(cursorAccountPoolConfig(config).strategy);
}

function stickyLimit(config: OcxConfig): number {
  return normalizeAccountPoolStickyLimit(cursorAccountPoolConfig(config).stickyLimit);
}

function parseRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
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

export function getCursorAccountHealthSnapshot(
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

export function clearCursorAccountCooldown(accountId: string): boolean {
  return upstreamHealth.delete(accountId);
}

export function clearCursorAccountPoolState(): void {
  upstreamHealth.clear();
  sessionAffinity.clear();
}

function credentialIsUsable(accountId: string, now: number): boolean {
  const credential = getAccountCredential(PROVIDER, accountId);
  if (!credential) return false;
  return Boolean(credential.refresh) || credential.expires > now + TOKEN_SKEW_MS;
}

export function getEligibleCursorAccounts(now = Date.now()): string[] {
  const set = getAccountSet(PROVIDER);
  if (!set) return [];
  return set.accounts
    .filter(account =>
      account.needsReauth !== true
      && getCursorAccountHealthSnapshot(account.id, now) === null
      && credentialIsUsable(account.id, now))
    .map(account => account.id);
}

export function getCursorPoolRetryAfterSeconds(now = Date.now()): number | null {
  const set = getAccountSet(PROVIDER);
  if (!set) return null;
  let earliest: number | null = null;
  for (const account of set.accounts) {
    const until = getCursorAccountHealthSnapshot(account.id, now)?.cooldownUntil;
    if (until && (earliest === null || until < earliest)) earliest = until;
  }
  return earliest && earliest > now ? Math.max(1, Math.ceil((earliest - now) / 1_000)) : null;
}

function usageScore(accountId: string): number {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  const value = quota?.monthlyPercent ?? quota?.fiveHourPercent ?? quota?.weeklyPercent;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : UNKNOWN_USAGE_SCORE;
}

function hasKnownUsage(accountId: string): boolean {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  const value = quota?.monthlyPercent ?? quota?.fiveHourPercent ?? quota?.weeklyPercent;
  return typeof value === "number" && Number.isFinite(value);
}

function pickLowestUsage(excludeId: string | undefined, now: number): string | null {
  const eligible = getEligibleCursorAccounts(now).filter(accountId => accountId !== excludeId);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, candidate) =>
    usageScore(candidate) < usageScore(best) ? candidate : best);
}

function isUnderThreshold(config: OcxConfig, accountId: string): boolean {
  const threshold = cursorAutoSwitchThreshold(config);
  return threshold <= 0 || !hasKnownUsage(accountId) || usageScore(accountId) < threshold;
}

function pickNextFillFirst(
  config: OcxConfig,
  afterId: string,
  eligible: string[],
): string | null {
  if (eligible.length === 0) return null;
  const ordered = [...eligible].sort((left, right) => left.localeCompare(right));
  const stableAll = (getAccountSet(PROVIDER)?.accounts.map(account => account.id) ?? ordered)
    .sort((left, right) => left.localeCompare(right));
  const start = stableAll.indexOf(afterId);
  let fallback: string | null = null;
  for (let step = 1; step <= stableAll.length; step++) {
    const candidate = stableAll[(Math.max(start, -1) + step) % stableAll.length]!;
    if (!eligible.includes(candidate)) continue;
    fallback ??= candidate;
    if (isUnderThreshold(config, candidate)) return candidate;
  }
  return fallback ?? ordered[0] ?? null;
}

function pickFillFirst(config: OcxConfig, now: number): string | null {
  const eligible = getEligibleCursorAccounts(now);
  const active = getAccountSet(PROVIDER)?.activeAccountId;
  if (active && eligible.includes(active) && isUnderThreshold(config, active)) return active;
  if (!active) return eligible.find(accountId => isUnderThreshold(config, accountId))
    ?? eligible[0]
    ?? null;
  return pickNextFillFirst(config, active, eligible);
}

function pruneAffinity(now: number): void {
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

export function bindCursorSessionAffinity(
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  const key = sessionKey?.trim();
  if (!key) return;
  sessionAffinity.set(key, { accountId, lastUsedAt: now });
  pruneAffinity(now);
}

export function clearCursorSessionAffinityForAccount(accountId: string): void {
  for (const [key, entry] of sessionAffinity) {
    if (entry.accountId === accountId) sessionAffinity.delete(key);
  }
}

export function cursorSessionKeyFromParts(input: {
  clientThreadId?: string | null;
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  promptCacheKey?: string | null;
  cursorConversationId?: string | null;
}): string | null {
  const source = input.clientThreadId?.trim()
    || input.sessionIdHeader?.trim()
    || input.threadIdHeader?.trim()
    || input.promptCacheKey?.trim()
    || input.cursorConversationId?.trim();
  if (!source) return null;
  return createHash("sha256").update("ocx:cursor-pool:").update(source).digest("hex");
}

export function resolveCursorAccountForSession(
  sessionKey: string | null | undefined,
  config: OcxConfig,
  now = Date.now(),
): CursorAccountSelection {
  pruneAffinity(now);
  const set = getAccountSet(PROVIDER);
  if (!set || set.accounts.length === 0) return { accountId: null, reason: "none" };
  if (!isCursorAccountPoolEnabled(config)) {
    return { accountId: set.activeAccountId, reason: "pool-disabled" };
  }

  const eligible = getEligibleCursorAccounts(now);
  const key = sessionKey?.trim();
  if (key) {
    const affined = sessionAffinity.get(key);
    if (affined && eligible.includes(affined.accountId)) {
      affined.lastUsedAt = now;
      return { accountId: affined.accountId, reason: "affinity" };
    }
    sessionAffinity.delete(key);
  }

  const strategy = poolStrategy(config);
  const active = set.activeAccountId;
  if (!key && eligible.includes(active) && strategy !== "quota") {
    return { accountId: active, reason: "active" };
  }
  let accountId: string | null = null;
  let reason: CursorAccountSelectionReason = "none";
  if (strategy === "round-robin") {
    accountId = pickRoundRobinAccount(POOL_KEY_CURSOR, eligible, stickyLimit(config));
    if (accountId) {
      notePoolRotationSuccess(POOL_KEY_CURSOR, accountId, stickyLimit(config));
      reason = "round-robin";
    }
  } else if (strategy === "fill-first") {
    accountId = pickFillFirst(config, now);
    if (accountId) reason = "fill-first";
  } else if (eligible.includes(active) && isUnderThreshold(config, active)) {
    accountId = active;
    reason = "active";
  } else if (cursorAutoSwitchThreshold(config) > 0) {
    accountId = pickLowestUsage(undefined, now);
    if (accountId) reason = accountId === active ? "active" : "lowest-usage";
  } else {
    accountId = pickLowestUsage(active, now);
    if (accountId) reason = "only-eligible";
  }

  if (!accountId) {
    const anyCooled = set.accounts.some(account =>
      getCursorAccountHealthSnapshot(account.id, now) !== null);
    return { accountId: null, reason: anyCooled ? "all-cooled" : "none" };
  }
  bindCursorSessionAffinity(key, accountId, now);
  return { accountId, reason };
}

export function isCursorPoolRotationError(message: string): boolean {
  const outcome = classifyCursorUpstreamOutcome({ message });
  return outcome === "rate-limit" || outcome === "quota-exhausted";
}

export function rotateCursorAccountOnQuota(
  config: OcxConfig,
  failedAccountId: string,
  retryAfter: string | null | undefined,
  sessionKey?: string | null,
  now = Date.now(),
): string | null {
  if (!isCursorAccountPoolEnabled(config)) return null;
  const parsedRetryAfter = parseRetryAfterMs(retryAfter, now);
  upstreamHealth.set(failedAccountId, {
    cooldownUntil: now + (parsedRetryAfter ?? DEFAULT_COOLDOWN_MS),
    cooldownSource: parsedRetryAfter ? "retry-after" : "default",
  });
  clearCursorSessionAffinityForAccount(failedAccountId);
  notePoolRotationFailure(POOL_KEY_CURSOR, failedAccountId);

  const eligible = getEligibleCursorAccounts(now).filter(accountId => accountId !== failedAccountId);
  const strategy = poolStrategy(config);
  const next = strategy === "round-robin"
    ? pickRoundRobinAccount(POOL_KEY_CURSOR, eligible, stickyLimit(config))
    : strategy === "fill-first"
      ? pickNextFillFirst(config, failedAccountId, eligible)
      : pickLowestUsage(failedAccountId, now);
  if (!next) return null;
  bindCursorSessionAffinity(sessionKey, next, now);
  console.warn(
    `[cursor-pool] quota on ${fallbackCodexAccountLogLabel(failedAccountId)}; failing over to ${fallbackCodexAccountLogLabel(next)}`,
  );
  return next;
}

export async function getCursorPoolAccessToken(accountId: string): Promise<string> {
  const { getValidAccessTokenForAccount } = await import("./index");
  return getValidAccessTokenForAccount(PROVIDER, accountId);
}

export function promoteCursorActiveAccount(accountId: string): void {
  void setActiveAccount(PROVIDER, accountId).catch(() => {});
}

export function resetCursorRoutingForManualSelection(accountId: string): void {
  sessionAffinity.clear();
  seedPoolRotationAccount(POOL_KEY_CURSOR, accountId);
}

export function formatCursorProviderForLog(accountId: string | null | undefined): string {
  return accountId ? `${PROVIDER}-${fallbackCodexAccountLogLabel(accountId)}` : PROVIDER;
}
