/**
 * Pre-request pick: who may take this attempt. Returns a fetch-ready provider.
 * The turn maps domain failures to HTTP; it does not choose an adapter.
 */
import type { CodexAccountCooldownError, CodexAuthContext } from "../codex/auth-context";
import type { CodexAccountMode, OcxConfig, OcxProviderConfig } from "../types";
import {
  getOAuthCredentialApiBaseUrl,
  getOAuthCredentialProjectId,
  getValidAccessTokenSnapshot,
  type OAuthAccessSnapshot,
  UnsupportedOAuthProviderError,
} from "../oauth";
import { redactSecretString } from "../lib/redact";
import { providerCredentialFailure, providerCredentialRef, withResolvedProviderCredential } from "../providers/credential";
import { resolveProviderTransport } from "../providers/xai-transport";
import { selectCodexCandidate } from "./codex-pool";
import { selectOauthPoolCandidate, type OauthPoolName } from "./oauth-pool";
import { selectKeyPoolCandidate } from "./resolve";

export type SelectCandidateInput = {
  providerName: string;
  config: OcxConfig;
  routedProvider: OcxProviderConfig;
  sessionKey?: string | null;
  promptCacheKey?: string;
  now?: number;
  /** When set, Codex first-pick runs before OAuth / vault / key pool. */
  headers?: Headers;
  mode?: CodexAccountMode;
  modelId?: string;
};

export type SelectCandidateOk = {
  ok: true;
  provider: OcxProviderConfig;
  logProvider?: string;
  oauthPool?: { pool: OauthPoolName; accountId: string };
  oauthSnapshot?: OAuthAccessSnapshot;
  authCtx?: CodexAuthContext;
  headers?: Headers;
};

export type SelectCandidateFail =
  | { ok: false; kind: "oauth-all-cooled"; pool: OauthPoolName; retryAfterSeconds: number | null }
  | { ok: false; kind: "oauth-none"; pool: OauthPoolName }
  | { ok: false; kind: "oauth-unsupported"; message: string }
  | { ok: false; kind: "oauth-auth"; message: string }
  | { ok: false; kind: "key-all-cooled"; retryAfterSeconds: number }
  | { ok: false; kind: "vault"; status: number; type: string; message: string }
  | { ok: false; kind: "codex-cooldown"; error: CodexAccountCooldownError }
  | { ok: false; kind: "codex-affinity-expired" }
  | { ok: false; kind: "codex-reauth"; accountId: string }
  | { ok: false; kind: "codex-unusable" }
  | { ok: false; kind: "codex-pool-auth"; message: string }
  | { ok: false; kind: "codex-direct-auth"; message: string };

export type SelectCandidateResult = SelectCandidateOk | SelectCandidateFail;

function codexSelectFail(reason: Exclude<Awaited<ReturnType<typeof selectCodexCandidate>>, { ok: true }>): SelectCandidateFail {
  switch (reason.reason) {
    case "cooldown":
      return { ok: false, kind: "codex-cooldown", error: reason.error };
    case "affinity-expired":
      return { ok: false, kind: "codex-affinity-expired" };
    case "reauth":
      return { ok: false, kind: "codex-reauth", accountId: reason.accountId };
    case "unusable":
      return { ok: false, kind: "codex-unusable" };
    case "pool-auth":
      return { ok: false, kind: "codex-pool-auth", message: redactSecretString(reason.message) };
    case "direct-auth":
      return { ok: false, kind: "codex-direct-auth", message: redactSecretString(reason.message) };
  }
}

/**
 * First pick for this attempt: Codex (when headers are supplied), then OAuth
 * pool, single-account OAuth, ChefVault lease, then key pool.
 */
export async function selectCandidate(input: SelectCandidateInput): Promise<SelectCandidateResult> {
  let provider = input.routedProvider;
  let logProvider: string | undefined;
  let oauthPool: SelectCandidateOk["oauthPool"];
  let oauthSnapshot: OAuthAccessSnapshot | undefined;
  let authCtx: CodexAuthContext | undefined;
  let headers: Headers | undefined;

  if (input.headers) {
    const codex = await selectCodexCandidate({
      headers: input.headers,
      config: input.config,
      mode: input.mode,
      modelId: input.modelId ?? "",
      routedProvider: provider,
    });
    if (!codex.ok) return codexSelectFail(codex);
    provider = codex.provider;
    authCtx = codex.authCtx;
    headers = codex.headers;
  }

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
        return { ok: false, kind: "oauth-unsupported", message: redactSecretString(err.message) };
      }
      return {
        ok: false,
        kind: "oauth-auth",
        message: redactSecretString(err instanceof Error ? err.message : String(err)),
      };
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
  if (keyPick.kind === "all-cooled") {
    return { ok: false, kind: "key-all-cooled", retryAfterSeconds: keyPick.retryAfterSeconds };
  }
  if (keyPick.kind === "selected") provider = { ...provider, apiKey: keyPick.transport.apiKey };

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
    ...(authCtx ? { authCtx } : {}),
    ...(headers ? { headers } : {}),
  };
}
