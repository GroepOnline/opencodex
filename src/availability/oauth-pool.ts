import type { OcxConfig, OcxProviderConfig } from "../types";
import { isAccountPoolHopStatus } from "./classify";
import {
  bindAnthropicSessionAffinity,
  formatAnthropicProviderForLog,
  getAnthropicPoolAccessToken,
  getAnthropicPoolRetryAfterSeconds,
  isAnthropicAccountPoolEnabled,
  promoteAnthropicActiveAccount,
  resolveAnthropicAccountForSession,
  rotateAnthropicAccountOn429,
} from "../oauth/anthropic-routing";
import {
  bindGoogleAntigravitySessionAffinity,
  formatGoogleAntigravityProviderForLog,
  getGoogleAntigravityPoolCredential,
  getGoogleAntigravityPoolRetryAfterSeconds,
  isGoogleAntigravityAccountPoolEnabled,
  promoteGoogleAntigravityActiveAccount,
  releaseGoogleAntigravitySessionAffinity,
  resolveGoogleAntigravityAccountForSession,
  rotateGoogleAntigravityAccountOn429,
} from "../oauth/google-antigravity-routing";
import {
  bindCursorSessionAffinity,
  formatCursorProviderForLog,
  getCursorPoolAccessToken,
  getCursorPoolRetryAfterSeconds,
  isCursorAccountPoolEnabled,
  isCursorPoolRotationError,
  promoteCursorActiveAccount,
  resolveCursorAccountForSession,
  rotateCursorAccountOnQuota,
} from "../oauth/cursor-routing";

export type OauthPoolName = "anthropic" | "google-antigravity" | "cursor";

export type OauthPoolHop = {
  accountId: string;
  provider: OcxProviderConfig;
  logProvider: string;
};

export type OauthPoolSelectResult =
  | { kind: "not-pooled" }
  | { kind: "selected"; pool: OauthPoolName; hop: OauthPoolHop }
  | { kind: "all-cooled"; pool: OauthPoolName; retryAfterSeconds: number | null }
  | { kind: "none"; pool: OauthPoolName };

function oauthPoolSelectMiss(
  pool: OauthPoolName,
  reason: string,
  now: number,
): OauthPoolSelectResult {
  if (reason === "all-cooled") {
    const retryAfterSeconds = pool === "anthropic"
      ? getAnthropicPoolRetryAfterSeconds(now)
      : pool === "google-antigravity"
        ? getGoogleAntigravityPoolRetryAfterSeconds(now)
        : getCursorPoolRetryAfterSeconds(now);
    return { kind: "all-cooled", pool, retryAfterSeconds };
  }
  return { kind: "none", pool };
}

/**
 * First OAuth-pool pick for this attempt. Returns a fetch-ready provider, or
 * not-pooled so the turn uses the single-account token snapshot.
 */
export async function selectOauthPoolCandidate(input: {
  providerName: string;
  config: OcxConfig;
  routedProvider: OcxProviderConfig;
  sessionKey?: string | null;
  now?: number;
}): Promise<OauthPoolSelectResult> {
  if (input.routedProvider.authMode !== "oauth") return { kind: "not-pooled" };
  const now = input.now ?? Date.now();
  const sessionKey = input.sessionKey;

  if (input.providerName === "anthropic" && isAnthropicAccountPoolEnabled(input.config)) {
    const selection = resolveAnthropicAccountForSession(sessionKey, input.config, now);
    if (!selection.accountId) return oauthPoolSelectMiss("anthropic", selection.reason, now);
    const accessToken = await getAnthropicPoolAccessToken(selection.accountId);
    bindAnthropicSessionAffinity(sessionKey, selection.accountId, now);
    promoteAnthropicActiveAccount(selection.accountId);
    return {
      kind: "selected",
      pool: "anthropic",
      hop: {
        accountId: selection.accountId,
        provider: { ...input.routedProvider, apiKey: accessToken },
        logProvider: formatAnthropicProviderForLog("anthropic", selection.accountId, input.config),
      },
    };
  }

  if (input.providerName === "google-antigravity" && isGoogleAntigravityAccountPoolEnabled(input.config)) {
    const selection = resolveGoogleAntigravityAccountForSession(sessionKey, input.config, now);
    if (!selection.accountId) {
      return oauthPoolSelectMiss("google-antigravity", selection.reason, now);
    }
    const credential = await getGoogleAntigravityPoolCredential(selection.accountId);
    bindGoogleAntigravitySessionAffinity(sessionKey, selection.accountId, now);
    promoteGoogleAntigravityActiveAccount(selection.accountId);
    return {
      kind: "selected",
      pool: "google-antigravity",
      hop: {
        accountId: selection.accountId,
        provider: {
          ...input.routedProvider,
          apiKey: credential.accessToken,
          project: credential.projectId,
        },
        logProvider: formatGoogleAntigravityProviderForLog(selection.accountId),
      },
    };
  }

  if (input.providerName === "cursor" && isCursorAccountPoolEnabled(input.config)) {
    const selection = resolveCursorAccountForSession(sessionKey, input.config, now);
    if (!selection.accountId) return oauthPoolSelectMiss("cursor", selection.reason, now);
    const accessToken = await getCursorPoolAccessToken(selection.accountId);
    bindCursorSessionAffinity(sessionKey, selection.accountId, now);
    promoteCursorActiveAccount(selection.accountId);
    return {
      kind: "selected",
      pool: "cursor",
      hop: {
        accountId: selection.accountId,
        provider: { ...input.routedProvider, apiKey: accessToken },
        logProvider: formatCursorProviderForLog(selection.accountId),
      },
    };
  }

  return { kind: "not-pooled" };
}

/**
 * Cool the failed Anthropic OAuth account and return a fetch-ready provider, or null to surface.
 */
export async function resolveAnthropicPoolOutcome(input: {
  config: OcxConfig;
  status: number;
  failedAccountId: string;
  routedProvider: OcxProviderConfig;
  retryAfter?: string | null;
  sessionKey?: string | null;
  now?: number;
}): Promise<OauthPoolHop | null> {
  if (!isAccountPoolHopStatus(input.status)) return null;
  if (!isAnthropicAccountPoolEnabled(input.config)) return null;
  const nextAccountId = rotateAnthropicAccountOn429(
    input.config,
    input.failedAccountId,
    input.retryAfter,
    input.sessionKey,
    input.now,
  );
  if (!nextAccountId) return null;
  try {
    const accessToken = await getAnthropicPoolAccessToken(nextAccountId);
    promoteAnthropicActiveAccount(nextAccountId);
    return {
      accountId: nextAccountId,
      provider: { ...input.routedProvider, apiKey: accessToken },
      logProvider: formatAnthropicProviderForLog("anthropic", nextAccountId, input.config),
    };
  } catch {
    return null;
  }
}

/**
 * Cool the failed Antigravity account and return a fetch-ready provider, or null to surface.
 * Credential failure drops the affinity that rotation just bound.
 */
export async function resolveGoogleAntigravityPoolOutcome(input: {
  config: OcxConfig;
  status: number;
  failedAccountId: string;
  routedProvider: OcxProviderConfig;
  retryAfter?: string | null;
  sessionKey?: string | null;
  now?: number;
}): Promise<OauthPoolHop | null> {
  if (!isAccountPoolHopStatus(input.status)) return null;
  if (!isGoogleAntigravityAccountPoolEnabled(input.config)) return null;
  const nextAccountId = rotateGoogleAntigravityAccountOn429(
    input.config,
    input.failedAccountId,
    input.retryAfter,
    input.sessionKey,
    input.now,
  );
  if (!nextAccountId) return null;
  try {
    const credential = await getGoogleAntigravityPoolCredential(nextAccountId);
    promoteGoogleAntigravityActiveAccount(nextAccountId);
    return {
      accountId: nextAccountId,
      provider: {
        ...input.routedProvider,
        apiKey: credential.accessToken,
        project: credential.projectId,
      },
      logProvider: formatGoogleAntigravityProviderForLog(nextAccountId),
    };
  } catch {
    releaseGoogleAntigravitySessionAffinity(input.sessionKey, nextAccountId);
    return null;
  }
}

/**
 * Cool the failed Cursor account on quota/overload copy and return a fetch-ready provider.
 */
export async function resolveCursorPoolOutcome(input: {
  config: OcxConfig;
  message: string;
  failedAccountId: string;
  routedProvider: OcxProviderConfig;
  retryAfter?: string | null;
  sessionKey?: string | null;
  now?: number;
}): Promise<OauthPoolHop | null> {
  if (!isCursorPoolRotationError(input.message)) return null;
  const nextAccountId = rotateCursorAccountOnQuota(
    input.config,
    input.failedAccountId,
    input.retryAfter ?? null,
    input.sessionKey,
    input.now,
  );
  if (!nextAccountId) return null;
  try {
    const accessToken = await getCursorPoolAccessToken(nextAccountId);
    promoteCursorActiveAccount(nextAccountId);
    return {
      accountId: nextAccountId,
      provider: { ...input.routedProvider, apiKey: accessToken },
      logProvider: formatCursorProviderForLog(nextAccountId),
    };
  } catch {
    return null;
  }
}
