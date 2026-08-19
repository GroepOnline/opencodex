import type { OcxConfig, OcxProviderConfig } from "../types";
import { applyAccountQuotaFromUpstreamHeaders } from "../codex/auth-api";
import {
  applyCodexAuthContextToProvider,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexPoolAuthenticationError,
  headersForCodexAuthContext,
  resolveCodexAuthContext,
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
