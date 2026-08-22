import type { CodexAccountMode, OcxConfig, OcxProviderConfig } from "../types";
import { applyAccountQuotaFromUpstreamHeaders } from "../codex/auth-api";
import {
  applyCodexAuthContextToProvider,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  releaseCodexAuthContextProbeLease,
  codexProbeLeaseId,
  codexProbeQuotaScope,
  stripCodexRuntimeProviderFields,
  type CodexAuthContext,
} from "../codex/auth-context";
import { computeQuotaCooldown, recordCodexUpstreamOutcome } from "../codex/routing";

export type CodexPoolAuth = Extract<CodexAuthContext, { kind: "pool" | "main-pool" }>;

export type CodexPoolHop = {
  authCtx: CodexPoolAuth;
  provider: OcxProviderConfig;
  headers: Headers;
};

export type CodexSelectResult =
  | {
    ok: true;
    authCtx: CodexAuthContext;
    headers: Headers;
    provider: OcxProviderConfig;
  }
  | { ok: false; reason: "cooldown"; error: CodexAccountCooldownError }
  | { ok: false; reason: "affinity-expired"; error: CodexThreadAffinityExpiredError }
  | { ok: false; reason: "unusable" }
  | { ok: false; reason: "reauth"; accountId: string; error: CodexAuthContextError }
  | { ok: false; reason: "pool-auth"; message: string }
  | { ok: false; reason: "direct-auth"; message: string };

/**
 * First Codex pick for this attempt. Returns a fetch-ready provider and
 * headers, or a domain failure the turn maps to HTTP. Does not fetch.
 * Direct admission (caller credential present) stays on the turn.
 */
export async function selectCodexCandidate(input: {
  headers: Headers;
  config: OcxConfig;
  mode?: CodexAccountMode;
  modelId: string;
  routedProvider: OcxProviderConfig;
}): Promise<CodexSelectResult> {
  try {
    const authCtx = input.mode
      ? await resolveCodexAuthContext(input.headers, input.config, input.mode, {
        modelId: input.modelId,
      })
      : { kind: "main" as const, accountId: null };
    if (!isCodexAuthContextUsable(authCtx, input.config)) {
      releaseCodexAuthContextProbeLease(authCtx);
      return { ok: false, reason: "unusable" };
    }
    return {
      ok: true,
      authCtx,
      headers: headersForCodexAuthContext(input.headers, authCtx),
      provider: applyCodexAuthContextToProvider(input.routedProvider, authCtx, input.mode),
    };
  } catch (err) {
    if (err instanceof CodexAccountCooldownError) {
      return { ok: false, reason: "cooldown", error: err };
    }
    if (err instanceof CodexThreadAffinityExpiredError) {
      return { ok: false, reason: "affinity-expired", error: err };
    }
    if (err instanceof CodexAuthContextError) {
      return { ok: false, reason: "reauth", accountId: err.accountId, error: err };
    }
    if (err instanceof CodexPoolAuthenticationError) {
      return { ok: false, reason: "pool-auth", message: err.message };
    }
    if (err instanceof CodexDirectAuthenticationError) {
      return { ok: false, reason: "direct-auth", message: err.message };
    }
    throw err;
  }
}

export function codexQuotaOutcomeMeta(response: Response): {
  retryAfter: string | null;
  resetAt: string[];
} {
  return {
    retryAfter: response.headers.get("retry-after"),
    resetAt: [
      response.headers.get("x-codex-primary-reset-at"),
      response.headers.get("x-codex-secondary-reset-at"),
      response.headers.get("x-codex-tertiary-reset-at"),
    ].filter((value): value is string => !!value),
  };
}

/**
 * A reset timestamp describes a quota window, not an instruction to stop using
 * the whole account. A combo may try a later model in the same request.
 */
export function shouldDeferCodexResetDerivedCooldown(response: Response, enabled?: boolean): boolean {
  return enabled === true
    && (response.status === 429 || response.status === 402)
    && computeQuotaCooldown(codexQuotaOutcomeMeta(response)).source === "reset-derived";
}

function isCodexPoolAuth(ctx: CodexAuthContext | undefined): ctx is CodexPoolAuth {
  return ctx?.kind === "pool" || ctx?.kind === "main-pool";
}

/**
 * Select the next Codex pool account, record the failed attempt, and return a
 * fetch-ready provider plus headers. Does not fetch upstream.
 */
export async function resolveCodexPoolOutcome(input: {
  headers: Headers;
  config: OcxConfig;
  firstAuthCtx: CodexPoolAuth;
  firstResponse: Response;
  outcomeStatus: number;
  modelId: string;
  routedProvider: OcxProviderConfig;
  deferCodexResetDerivedCooldown?: boolean;
}): Promise<CodexPoolHop | null> {
  let retryAuthCtx: CodexAuthContext | undefined;
  try {
    retryAuthCtx = await resolveCodexAuthContext(
      input.headers,
      input.config,
      "pool",
      { excludeAccountId: input.firstAuthCtx.accountId, modelId: input.modelId },
    );
  } catch (error) {
    if (
      !(error instanceof CodexPoolAuthenticationError)
      && !(error instanceof CodexAuthContextError)
      && !(error instanceof CodexAccountCooldownError)
    ) throw error;
  }
  if (!isCodexPoolAuth(retryAuthCtx)) return null;

  const quotaMeta = codexQuotaOutcomeMeta(input.firstResponse);
  if (input.outcomeStatus === 429 || input.outcomeStatus === 402) {
    applyAccountQuotaFromUpstreamHeaders(input.firstAuthCtx.accountId, input.firstResponse.headers);
  }
  if (!shouldDeferCodexResetDerivedCooldown(input.firstResponse, input.deferCodexResetDerivedCooldown)) {
    recordCodexUpstreamOutcome(input.config, input.firstAuthCtx.accountId, input.outcomeStatus, {
      ...quotaMeta,
      threadId: input.headers.get("x-codex-parent-thread-id"),
      modelId: input.modelId,
      probeLeaseId: codexProbeLeaseId(input.firstAuthCtx),
      probeQuotaScope: codexProbeQuotaScope(input.firstAuthCtx),
      ...(retryAuthCtx.accountId ? { promoteAccountId: retryAuthCtx.accountId } : {}),
    });
  }

  return {
    authCtx: retryAuthCtx,
    provider: applyCodexAuthContextToProvider(
      stripCodexRuntimeProviderFields(input.routedProvider),
      retryAuthCtx,
      "pool",
    ),
    headers: headersForCodexAuthContext(input.headers, retryAuthCtx),
  };
}
