/**
 * Pre-request pick: who may take this attempt. Returns a fetch-ready provider.
 * The turn maps domain failures to HTTP; it does not choose an adapter.
 */
import type { OcxConfig, OcxProviderConfig } from "../types";
import {
  getOAuthCredentialApiBaseUrl,
  getOAuthCredentialProjectId,
  getValidAccessTokenSnapshot,
  type OAuthAccessSnapshot,
  UnsupportedOAuthProviderError,
} from "../oauth";
import { providerCredentialFailure, providerCredentialRef, withResolvedProviderCredential } from "../providers/credential";
import { resolveProviderTransport } from "../providers/xai-transport";
import { selectOauthPoolCandidate, type OauthPoolName } from "./oauth-pool";
import { selectKeyPoolCandidate } from "./resolve";

export type SelectCandidateInput = {
  providerName: string;
  config: OcxConfig;
  routedProvider: OcxProviderConfig;
  sessionKey?: string | null;
  promptCacheKey?: string;
  now?: number;
};

export type SelectCandidateOk = {
  ok: true;
  provider: OcxProviderConfig;
  logProvider?: string;
  oauthPool?: { pool: OauthPoolName; accountId: string };
  oauthSnapshot?: OAuthAccessSnapshot;
};

export type SelectCandidateFail =
  | { ok: false; kind: "oauth-all-cooled"; pool: OauthPoolName; retryAfterSeconds: number | null }
  | { ok: false; kind: "oauth-none"; pool: OauthPoolName }
  | { ok: false; kind: "oauth-unsupported"; message: string }
  | { ok: false; kind: "oauth-auth"; message: string }
  | { ok: false; kind: "vault"; status: number; type: string; message: string };

export type SelectCandidateResult = SelectCandidateOk | SelectCandidateFail;

/**
 * First pick for this attempt: OAuth pool, single-account OAuth, ChefVault lease,
 * then key pool. Codex stays on selectCodexCandidate (settled earlier in the turn).
 */
export async function selectCandidate(input: SelectCandidateInput): Promise<SelectCandidateResult> {
  let provider = input.routedProvider;
  let logProvider: string | undefined;
  let oauthPool: SelectCandidateOk["oauthPool"];
  let oauthSnapshot: OAuthAccessSnapshot | undefined;

  if (provider.authMode === "oauth") {
    try {
      const poolPick = await selectOauthPoolCandidate({
        providerName: input.providerName,
        config: input.config,
        routedProvider: provider,
        sessionKey: input.sessionKey,
        now: input.now,
      });
      if (poolPick.kind === "all-cooled") {
        return {
          ok: false,
          kind: "oauth-all-cooled",
          pool: poolPick.pool,
          retryAfterSeconds: poolPick.retryAfterSeconds,
        };
      }
      if (poolPick.kind === "none") {
        return { ok: false, kind: "oauth-none", pool: poolPick.pool };
      }
      if (poolPick.kind === "selected") {
        provider = poolPick.hop.provider;
        logProvider = poolPick.hop.logProvider;
        oauthPool = { pool: poolPick.pool, accountId: poolPick.hop.accountId };
      } else {
        const resolved = await getValidAccessTokenSnapshot(input.providerName);
        oauthSnapshot = resolved;
        provider = { ...provider, apiKey: resolved.accessToken };
        if (provider.googleMode === "cloud-code-assist" && !provider.project) {
          const projectId = getOAuthCredentialProjectId(input.providerName);
          if (projectId) provider = { ...provider, project: projectId };
        }
      }
    } catch (err) {
      if (err instanceof UnsupportedOAuthProviderError) {
        return { ok: false, kind: "oauth-unsupported", message: err.message };
      }
      return { ok: false, kind: "oauth-auth", message: err instanceof Error ? err.message : String(err) };
    }
  } else if (provider.authMode !== "forward" && providerCredentialRef(provider)) {
    try {
      provider = await withResolvedProviderCredential(provider);
    } catch (err) {
      const failure = providerCredentialFailure(input.providerName, err);
      return { ok: false, kind: "vault", ...failure };
    }
  }

  const keyPick = selectKeyPoolCandidate({
    config: input.config,
    providerName: input.providerName,
    routedProvider: provider,
    promptCacheKey: input.promptCacheKey,
    now: input.now,
  });
  if (keyPick) provider = { ...provider, apiKey: keyPick.apiKey };

  provider = resolveProviderTransport(
    input.providerName,
    provider,
    input.promptCacheKey,
    input.providerName === "github-copilot" ? getOAuthCredentialApiBaseUrl(input.providerName) : undefined,
  );

  return {
    ok: true,
    provider,
    ...(logProvider ? { logProvider } : {}),
    ...(oauthPool ? { oauthPool } : {}),
    ...(oauthSnapshot ? { oauthSnapshot } : {}),
  };
}
