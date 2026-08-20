import { selectCandidate } from "../availability";
import { resolveEnvValue } from "../config";
import { providerCredentialRef } from "./credential";
import {
  CodexDirectAuthenticationError,
  CodexPoolAuthenticationError,
  headersForCodexAuthContext,
  hasCallerCodexBearer,
  type CodexAuthContext,
} from "../codex/auth-context";
import { recordCodexUpstreamOutcome, type CodexUpstreamOutcome } from "../codex/routing";
import { extractAccountId } from "../oauth/chatgpt";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "../server/auth-cors";
import type { CodexAccountMode, OcxConfig, OcxProviderConfig } from "../types";
import {
  isCanonicalOpenAiForwardProvider,
  OPENAI_API_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_ID,
} from "./openai-tiers";
import { getProviderRegistryEntry, providerCodexAccountMode } from "./registry";

export interface OpenAiForwardSidecarCandidate {
  providerName: typeof OPENAI_CODEX_PROVIDER_ID;
  provider: OcxProviderConfig;
  accountMode: CodexAccountMode;
}

export interface ResolvedOpenAiForwardSidecar extends OpenAiForwardSidecarCandidate {
  authContext: CodexAuthContext;
  headers: Headers;
  recordOutcome?: (outcome: CodexUpstreamOutcome) => void;
}

export interface OpenAiImagesProviderSelection {
  forwardCandidates: OpenAiForwardSidecarCandidate[];
  keyed?: {
    providerName: string;
    provider: OcxProviderConfig;
    apiKey: string;
  };
  error?: string;
  /** Response shape for `error`. Defaults to a 400 invalid_request_error (a configuration mistake). */
  errorStatus?: number;
  errorType?: string;
}

export function listOpenAiForwardSidecarCandidates(config: OcxConfig): OpenAiForwardSidecarCandidate[] {
  const provider = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (!provider || provider.disabled === true || !isCanonicalOpenAiForwardProvider(provider)) return [];
  return [{
    providerName: OPENAI_CODEX_PROVIDER_ID,
    provider,
    accountMode: providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, provider) ?? "pool",
  }];
}

function directSidecarHeaders(
  incomingHeaders: Headers,
): Headers | undefined {
  const bearer = incomingHeaders.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return undefined;
  const derivedAccountId = extractAccountId(undefined, bearer);
  if (!derivedAccountId) return undefined;
  const requestedAccountId = incomingHeaders.get("chatgpt-account-id")?.trim();
  // JWT payloads are decoded locally but not signature-verified. Requiring the caller's
  // explicit account header, and checking it against the token claim, makes forwarding an
  // intentional ChatGPT-auth operation instead of silently reclassifying any JWT-shaped
  // provider credential as a Codex bearer.
  if (!requestedAccountId || requestedAccountId !== derivedAccountId) return undefined;
  const selected = headersForCodexAuthContext(incomingHeaders, { kind: "main", accountId: null });
  return selected;
}

function imagesApiKey(provider: OcxProviderConfig): string | undefined {
  const raw = providerCredentialRef(provider) ? provider.apiKey : resolveEnvValue(provider.apiKey);
  return raw?.trim() || undefined;
}

export async function resolveFirstUsableOpenAiSidecar(
  candidates: readonly OpenAiForwardSidecarCandidate[],
  incomingHeaders: Headers,
  config: OcxConfig,
): Promise<ResolvedOpenAiForwardSidecar | undefined> {
  let callerBearerMayBeForwarded = true;
  try {
    validateForwardAdmissionCredential(incomingHeaders, config);
  } catch (error) {
    if (!(error instanceof ForwardAdmissionCredentialError)) throw error;
    callerBearerMayBeForwarded = false;
  }
  for (const candidate of candidates) {
    if (candidate.accountMode === "direct") {
      if (!callerBearerMayBeForwarded || !hasCallerCodexBearer(incomingHeaders)) continue;
      const headers = directSidecarHeaders(incomingHeaders);
      if (!headers) continue;
      return {
        ...candidate,
        authContext: { kind: "main", accountId: null },
        headers,
      };
    }
    const pick = await selectCandidate({
      providerName: candidate.providerName,
      config,
      routedProvider: candidate.provider,
      headers: incomingHeaders,
      mode: candidate.accountMode,
    });
    if (!pick.ok) {
      if (pick.kind === "codex-unusable") continue;
      if (pick.kind === "codex-cooldown") throw pick.error;
      if (pick.kind === "codex-reauth") throw pick.error;
      if (pick.kind === "codex-affinity-expired") throw pick.error;
      if (pick.kind === "codex-pool-auth") throw new CodexPoolAuthenticationError();
      if (pick.kind === "codex-direct-auth") throw new CodexDirectAuthenticationError();
      continue;
    }
    if (!pick.authCtx || !pick.headers) continue;
    const authContext = pick.authCtx;
    return {
      ...candidate,
      provider: pick.provider,
      authContext,
      headers: pick.headers,
      ...(authContext.kind === "pool" || authContext.kind === "main-pool"
        ? {
          recordOutcome: (outcome: CodexUpstreamOutcome) => recordCodexUpstreamOutcome(
            config,
            authContext.accountId,
            outcome,
            { probeLeaseId: authContext.probeLeaseId },
          ),
        }
        : {}),
    };
  }
  return undefined;
}

export async function selectOpenAiImagesProvider(config: OcxConfig): Promise<OpenAiImagesProviderSelection> {
  const selection: OpenAiImagesProviderSelection = {
    forwardCandidates: listOpenAiForwardSidecarCandidates(config),
  };
  const provider = config.providers[OPENAI_API_PROVIDER_ID];
  if (
    provider
    && provider.disabled !== true
    && provider.adapter === "openai-responses"
    && provider.authMode !== "forward"
    && provider.baseUrl.replace(/\/+$/, "") === "https://api.openai.com/v1"
  ) {
    const pick = await selectCandidate({
      providerName: OPENAI_API_PROVIDER_ID,
      config,
      routedProvider: provider,
    });
    if (pick.ok) {
      const apiKey = imagesApiKey(pick.provider);
      if (apiKey) {
        selection.keyed = { providerName: OPENAI_API_PROVIDER_ID, provider: pick.provider, apiKey };
      }
    }
  }
  return selection;
}

/** Resolve an explicit custom Images provider, otherwise preserve the existing OpenAI fallback. */
export async function selectImagesProvider(config: OcxConfig): Promise<OpenAiImagesProviderSelection> {
  const configuredProvider = config.images?.provider;
  if (configuredProvider === undefined) return selectOpenAiImagesProvider(config);
  if (typeof configuredProvider !== "string" || !configuredProvider.trim()) {
    return { forwardCandidates: [], error: "images.provider must be a nonblank provider name" };
  }
  const providerName = configuredProvider.trim();

  if (getProviderRegistryEntry(providerName)) {
    return {
      forwardCandidates: [],
      error: `images.provider "${providerName}" must name a custom provider; omit it to use built-in OpenAI tiers`,
    };
  }

  const provider = Object.prototype.hasOwnProperty.call(config.providers, providerName)
    ? config.providers[providerName]
    : undefined;
  if (!provider) {
    return { forwardCandidates: [], error: `images.provider "${providerName}" is not configured` };
  }
  if (provider.disabled === true) {
    return { forwardCandidates: [], error: `images.provider "${providerName}" is disabled` };
  }
  if (provider.adapter !== "openai-responses" || (provider.authMode !== undefined && provider.authMode !== "key")) {
    return {
      forwardCandidates: [],
      error: `images.provider "${providerName}" must be an API-key openai-responses provider`,
    };
  }

  // An explicitly configured Images provider has no other tier to fall back to, so a failed
  // ChefVault lease is reported as the credential/authority failure it is rather than as the
  // "no usable API key" configuration error.
  const pick = await selectCandidate({
    providerName,
    config,
    routedProvider: provider,
  });
  if (!pick.ok) {
    if (pick.kind === "vault") {
      return {
        forwardCandidates: [],
        error: pick.message,
        errorStatus: pick.status,
        errorType: pick.type,
      };
    }
    return { forwardCandidates: [], error: `images.provider "${providerName}" has no usable API key` };
  }
  const apiKey = imagesApiKey(pick.provider);
  if (!apiKey) {
    return { forwardCandidates: [], error: `images.provider "${providerName}" has no usable API key` };
  }

  return {
    forwardCandidates: [],
    keyed: { providerName, provider: pick.provider, apiKey },
  };
}
