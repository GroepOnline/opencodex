import type { OcxConfig, OcxProviderConfig } from "../types";
import { isAccountPoolHopStatus } from "./classify";
import {
  formatAnthropicProviderForLog,
  getAnthropicPoolAccessToken,
  isAnthropicAccountPoolEnabled,
  promoteAnthropicActiveAccount,
  rotateAnthropicAccountOn429,
} from "../oauth/anthropic-routing";
import {
  formatGoogleAntigravityProviderForLog,
  getGoogleAntigravityPoolCredential,
  isGoogleAntigravityAccountPoolEnabled,
  promoteGoogleAntigravityActiveAccount,
  releaseGoogleAntigravitySessionAffinity,
  rotateGoogleAntigravityAccountOn429,
} from "../oauth/google-antigravity-routing";
import {
  formatCursorProviderForLog,
  getCursorPoolAccessToken,
  isCursorPoolRotationError,
  promoteCursorActiveAccount,
  rotateCursorAccountOnQuota,
} from "../oauth/cursor-routing";

export type OauthPoolHop = {
  accountId: string;
  provider: OcxProviderConfig;
  logProvider: string;
};

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
