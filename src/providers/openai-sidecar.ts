import { providerCredentialFailure, resolveProviderApiKey, tryResolveProviderApiKey } from "./credential";
import { ProviderSecurityError } from "../provider-security";
import {
  headersForCodexAuthContext,
  hasCallerCodexBearer,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
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
    const authContext = await resolveCodexAuthContext(incomingHeaders, config, candidate.accountMode);
    if (!isCodexAuthContextUsable(authContext, config)) continue;
    return {
      ...candidate,
      authContext,
      headers: headersForCodexAuthContext(incomingHeaders, authContext),
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
    // A chefvault-backed provider has no inline key; lease it here so the keyed tier is armed
    // with real authentication instead of being skipped as unconfigured.
    const apiKey = await tryResolveProviderApiKey(provider);
    if (apiKey) selection.keyed = { providerName: OPENAI_API_PROVIDER_ID, provider, apiKey };
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
  let apiKey: string | undefined;
  try {
    apiKey = await resolveProviderApiKey(provider);
  } catch (error) {
    if (!(error instanceof ProviderSecurityError)) throw error;
    const failure = providerCredentialFailure(providerName, error);
    return {
      forwardCandidates: [],
      error: failure.message,
      errorStatus: failure.status,
      errorType: failure.type,
    };
  }
  if (!apiKey) {
    return { forwardCandidates: [], error: `images.provider "${providerName}" has no usable API key` };
  }

  return {
    forwardCandidates: [],
    keyed: { providerName, provider, apiKey },
  };
}
