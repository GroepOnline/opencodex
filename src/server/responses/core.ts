import type { Server } from "bun";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse, type ResponsesTerminalStatus } from "../../bridge";
import { formatPassthroughUpstreamError } from "./passthrough-error";
import { describeUpstreamConnectFailure } from "./upstream-error";
import {
  multiAgentGuidanceEnabled,
  resolveEnvValue,
} from "../../config";
import { parseRequest } from "../../responses/parser";
import { buildCompactV1Output, COMPACT_PROMPT, decodeCompactionSummary, extractCompactUserMessages } from "../../responses/compaction";
import { FORWARD_HEADERS, sanitizeReasoningInputContent } from "../../adapters/openai-responses";
import type { AdapterRequest } from "../../adapters/base";
import { expandPreviousResponseInput, previousResponseProviderState, rememberResponseState } from "../../responses/state";
import { routeModel, type RouteResult } from "../../router";
import {
  advanceComboAfterFailure,
  comboDefaultEffort,
  comboIdFromRawBody,
  concreteComboRequestBody,
  getCombo,
  isComboTargetInCooldown,
  NoAvailableComboTargetsError,
  noteComboSuccess,
  parseRetryAfterMs,
  pickComboTarget,
  targetKey,
} from "../../combos";
import {
  classifyAttempt,
  comboIdLabel,
  isAccountPoolHopStatus,
  isProviderFallbackComboId,
  keyPoolCanHop,
  recordCapOutcome,
  resolveAnthropicPoolOutcome,
  resolveCodexPoolOutcome,
  resolveCursorPoolOutcome,
  resolveGoogleAntigravityPoolOutcome,
  resolveOutcome,
  selectCandidate,
  selectHopChain,
  codexQuotaOutcomeMeta,
  shouldDeferCodexResetDerivedCooldown,
} from "../../availability";
import { isInjectionDebugEnabled } from "../../lib/debug-settings";
import { rateLimitForFailure } from "../../availability/rate-limit-parse";
import { injectionDebugLog } from "../../lib/injection-debug-log";
import { resolveClientRetryAfter } from "../../lib/retry-after";
import { modelInList, namespacedToolName } from "../../types";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig, OcxProviderContinuationState, OcxUsage } from "../../types";
import {
  forceRefreshOAuthAccessSnapshot,
  getOAuthCredentialApiBaseUrl,
  type OAuthAccessSnapshot,
} from "../../oauth";
import {
  ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST,
  anthropicSessionKeyFromParts,
  isAnthropicAccountPoolEnabled,
} from "../../oauth/anthropic-routing";
import {
  GOOGLE_ANTIGRAVITY_POOL_MAX_FAILOVERS_PER_REQUEST,
  googleAntigravitySessionKey,
  isGoogleAntigravityAccountPoolEnabled,
} from "../../oauth/google-antigravity-routing";
import {
  CURSOR_POOL_MAX_FAILOVERS_PER_REQUEST,
  cursorSessionKeyFromParts,
} from "../../oauth/cursor-routing";
import { buildWebSearchTool, planWebSearch, runWithWebSearch, shouldResolveOpenAiWebSearchSidecar } from "../../web-search";
import { buildImageTool, buildVideoTool, planImageBridge, planVideoBridge, runWithImageBridge, clampImageMaxRounds, IMAGE_GEN_TOOL_NAME, VIDEO_GEN_TOOL_NAME } from "../../images";
import { describeImagesInPlace, planVisionSidecar, shouldResolveOpenAiVisionSidecar, stripImagesInPlace } from "../../vision";
import { createAdapterEventQueue, preflightAdapterEvents } from "../../adapters/run-turn-queue";
import {
  CodexAccountCooldownError,
  cooldownErrorResponse,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
  codexProbeLeaseId,
  codexProbeQuotaScope,
  type CodexAuthContext,
} from "../../codex/auth-context";
import {
  formatCodexProviderForLog,
  previewCodexAccountForRequest,
  recordCodexUpstreamOutcome,
  type CodexUpstreamOutcome,
} from "../../codex/routing";
import { codexPaceBeforeSend, configuredCodexPoolSize } from "../../codex/pacer";
import { fetchWithResetRetry, fetchWithTransientRetry, applyUpstreamRecoveryInit } from "../../lib/upstream-retry";
import {
  createUpstreamAttemptBudget,
  type UpstreamAttemptBudget,
} from "../../lib/upstream-attempt-budget";
import {
  classifyUpstreamResponse,
  upstreamOutcomePolicy,
  type UpstreamRail,
} from "../../lib/upstream-outcome";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "../auth-cors";
import { selectCandidateFailResponse } from "./select-http";
import { listOpenAiForwardSidecarCandidates, resolveFirstUsableOpenAiSidecar, type ResolvedOpenAiForwardSidecar } from "../../providers/openai-sidecar";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { slugsEquivalent } from "../../providers/slug-codec";
import { applyOpenAiVirtualModel, resolveOpenAiCompactModel } from "../../providers/openai-virtual-models";
import { isUsageDebugEnabled } from "../../usage/debug";
import { readJsonRequestBody, DecompressedBodyTooLargeError, UnsupportedContentEncodingError } from "../request-decompress";
import { resolveAdapter, resolveWireProtocolOverride } from "../adapter-resolve";
import { shouldAttemptImageTierRetry } from "../image-retry";
import { resolveProviderTransport } from "../../providers/xai-transport";
import type { WsData } from "../ws-bridge";
import { registerTurn, trackStreamLifetime, unregisterTurn } from "../lifecycle";
import { redactSecretString } from "../../lib/redact";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { supportedLadderFor } from "../effort-policy";
import { isThreadSpawnRequest } from "../effort-policy";
import {
  applySubagentModelFallback,
  maybePrimeSubagentQuota,
  recordSubagentQuotaFailureForThreadSpawn,
} from "../../codex/subagent-model-fallback";
import {
  beginRequestAttempt,
  catalogModelSupportsServiceTier,
  finishRequestAttempt,
  inspectResponseLogJson,
  noteAttemptSend,
  readConfiguredCodexServiceTier,
  recordAdapterReasoning,
  recordAttemptRequestedEffort,
  requestLogSpeedLabel,
  sealRequestAttemptIdentity,
  usageFromResponsesPayload,
  type RequestLogContext,
} from "../request-log";
import {
  conversationIdFromResponsesRequest,
  normalizeLogConversationId,
  sessionIdHeaderFromRequest,
} from "../request-log-conversation";
import type { AttemptRecoveryKind } from "../../usage/log";
import {
  consumeForInspection,
  consumeForResponseLogMetadata,
  createSseInspector,
  markNativePassthroughSseResponse,
  relaySseWithFailedTail,
  relayWithAbort,
  sanitizePassthroughHeaders,
} from "../relay";
import { relaySseEagerBounded } from "../relay-eager";
import { decideEagerRelay } from "../../lib/bun-stream-caps";
import { cancelBodyOnAbort } from "../../lib/abort";
import {
  createResponsesItemIdPayloadRewrite,
  hasResponsesItemIdRepair,
} from "../responses-item-id-repair";
import {
  createImageGenCallRestoreRewrite,
  imageGenToolCallAliases,
  restoreImageGenCallsInJson,
} from "../responses-image-gen-repair";
import { composeSsePayloadRewrites, relaySseWithPayloadRewrite } from "../sse-payload-rewrite";
import type { EffectiveSubagentRoster, SpawnAgentSurface } from "../../codex/catalog";

import { buildToolBridgeMaps, collabSurface, injectDeveloperMessage, multiAgentGuidanceText } from "./collaboration";
import { hasUnreadableEncryptedAgentTask, looksLikeBackendCiphertext, sanitizeEncryptedContentInPlace } from "./encrypted-payload";
import { fetchWithHeaderTimeout, providerFetch, safeHostLabel } from "./fetch-helpers";
import { guardTerminalEventStream } from "./terminal-guard";

/**
 * Adapters whose continuation state must survive Codex's store:false requests.
 */
export function adapterNeedsForcedContinuation(name: string): boolean {
  return name === "kiro" || name === "cursor";
}

function outcomeRailForAdapter(name: string): UpstreamRail {
  if (name === "cursor") return "cursor";
  if (name === "google") return "google";
  if (name === "kiro") return "kiro";
  return "generic";
}

async function upstreamAllowsRotateOrCool(
  adapterName: string,
  response: Response,
  signal?: AbortSignal,
): Promise<boolean> {
  const outcome = await classifyUpstreamResponse(
    outcomeRailForAdapter(adapterName),
    response,
    signal,
  );
  return upstreamOutcomePolicy(outcome).rotateOrCool;
}

function adapterOwnsAttemptBudget(name: string): boolean {
  return name === "google" || name === "kiro";
}

export function sidecarOutcomeRecorder(
  config: OcxConfig,
  authCtx: CodexAuthContext,
  threadId?: string | null,
): ((outcome: CodexUpstreamOutcome) => void) | undefined {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool"
    ? outcome => recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, {
      threadId,
      probeLeaseId: authCtx.probeLeaseId,
    })
    : undefined;
}



export const DEFAULT_SHADOW_SOURCE_MODELS = ["gpt-5.4-mini", "gpt-5.6-luna"] as const;

export function isShadowSourceModel(modelId: string, configured?: unknown): boolean {
  if (modelId.includes("/")) return false;
  const configuredStrings = Array.isArray(configured)
    ? configured.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
  const prefixes = configuredStrings.length > 0 ? configuredStrings : DEFAULT_SHADOW_SOURCE_MODELS;
  return prefixes.some(prefix => modelId.startsWith(prefix.trim()));
}



export function codexLogAccountId(authCtx: CodexAuthContext): string | null {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool" ? authCtx.accountId : null;
}



export function usesCodexForwardPoolAuth(
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
): authCtx is Extract<CodexAuthContext, { kind: "pool" | "main-pool" }> {
  return (authCtx.kind === "pool" || authCtx.kind === "main-pool")
    && provider.authMode === "forward" && provider.adapter === "openai-responses";
}

function normalizeCodexUnsupportedModelDetail(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function isAllowListedCodexAccountModel400(
  status: number,
  bodyText: string,
  modelId: string,
): boolean {
  if (status !== 400) return false;
  try {
    const payload = JSON.parse(bodyText) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail !== "string") return false;
    const expected = `The '${modelId}' model is not supported when using Codex with a ChatGPT account.`;
    return normalizeCodexUnsupportedModelDetail(detail)
      === normalizeCodexUnsupportedModelDetail(expected);
  } catch {
    return false;
  }
}

async function peekUpstreamErrorText(response: Response, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    return body.displaySafe ? body.text : undefined;
  } catch {
    return undefined;
  }
}

async function shouldRetryCodexPoolAccountModel400(
  response: Response,
  modelId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (response.status !== 400) return false;
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    return body.displaySafe
      && !body.truncated
      && isAllowListedCodexAccountModel400(response.status, body.text, modelId);
  } catch {
    return false;
  }
}

/** Pre-stream quota/billing rejections that warrant one alternate-account attempt (#584). */
async function shouldRetryCodexPoolAccountQuota(
  response: Response,
  signal?: AbortSignal,
): Promise<boolean> {
  if (response.status !== 429 && response.status !== 402) return false;
  const outcome = await classifyUpstreamResponse("generic", response, signal);
  return upstreamOutcomePolicy(outcome).rotateOrCool;
}

interface CodexPoolAccountRetryArgs {
  req: Request;
  config: OcxConfig;
  route: { providerName: string; modelId: string; provider: OcxProviderConfig };
  parsed: OcxParsedRequest;
  logCtx: RequestLogContext;
  options: {
    abortSignal?: AbortSignal;
    onCodexAuthContextResolved?: (ctx: CodexAuthContext) => void;
    deferCodexResetDerivedCooldown?: boolean;
    attemptBudget?: UpstreamAttemptBudget;
  };
  firstAuthCtx: Extract<CodexAuthContext, { kind: "pool" | "main-pool" }>;
  firstResponse: Response;
  outcomeStatus: number;
  upstream: AbortController;
  connectMs: number;
  passthroughEstimate?: number;
  stream: boolean;
}

type CodexPoolAccountRetryResult =
  | {
    kind: "retried";
    authCtx: Extract<CodexAuthContext, { kind: "pool" | "main-pool" }>;
    request: Awaited<ReturnType<ReturnType<typeof resolveAdapter>["buildRequest"]>>;
    upstreamResponse: Response;
    selectedForwardHeaders: Headers;
  }
  | { kind: "no-alternate" }
  | {
    kind: "transport";
    error: unknown;
    authCtx: Extract<CodexAuthContext, { kind: "pool" | "main-pool" }>;
  }
  | {
    kind: "build-request-failed";
    response: Response;
  };

/**
 * One bounded alternate-account retry for Codex pool auth. Used for allow-listed
 * model-400 and for pre-stream 429/402 quota failures (#584).
 */
async function retryCodexPoolOnAlternateAccount(
  args: CodexPoolAccountRetryArgs,
): Promise<CodexPoolAccountRetryResult> {
  const {
    req, config, route, parsed, logCtx, options, firstAuthCtx, firstResponse,
    outcomeStatus, upstream, connectMs, passthroughEstimate, stream,
  } = args;
  if (options.attemptBudget?.remaining === 0) return { kind: "no-alternate" };
  const hop = await resolveCodexPoolOutcome({
    headers: req.headers,
    config,
    firstAuthCtx,
    firstResponse,
    outcomeStatus,
    modelId: route.modelId,
    routedProvider: route.provider,
    deferCodexResetDerivedCooldown: options.deferCodexResetDerivedCooldown,
  });
  if (!hop) return { kind: "no-alternate" };
  const retryAuthCtx = hop.authCtx;
  const retryHeaders = hop.headers;
  const retryProvider = hop.provider;
  const retryAdapter = resolveAdapter(
    resolveWireProtocolOverride(route.providerName, route.modelId, retryProvider),
    config.cacheRetention,
  );
  let request;
  try {
    request = await retryAdapter.buildRequest(parsed, { headers: retryHeaders });
  } catch (err) {
    return { kind: "build-request-failed", response: resolveAdapterBuildRequestError(err, options.abortSignal) };
  }
  recordAdapterReasoning(logCtx, request);

  await firstResponse.body?.cancel().catch(() => undefined);
  options.onCodexAuthContextResolved?.(retryAuthCtx);
  route.provider = retryProvider;
  logCtx.provider = formatCodexProviderForLog(
    route.providerName,
    retryAuthCtx.accountId,
    config,
  );

  noteAttemptSend(logCtx.activeAttempt, passthroughEstimate);
  if (options.attemptBudget && !options.attemptBudget.tryBegin()) {
    return { kind: "no-alternate" };
  }
  try {
    const upstreamResponse = await fetchWithHeaderTimeout(
      request.url,
      {
        method: request.method,
        headers: request.headers,
        body: request.body,
      },
      upstream.signal,
      connectMs,
      stream,
      providerFetch(route.provider),
    );
    return {
      kind: "retried",
      authCtx: retryAuthCtx,
      request,
      upstreamResponse,
      selectedForwardHeaders: retryHeaders,
    };
  } catch (error) {
    // Attribute the transport failure to the alternate account (already selected).
    return { kind: "transport", error, authCtx: retryAuthCtx };
  }
}



export function codexForwardTerminalOutcomeRecorder(
  config: OcxConfig,
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
  modelId?: string,
  logCtx?: RequestLogContext,
  threadId?: string | null,
): ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined {
  if (!usesCodexForwardPoolAuth(authCtx, provider)) return undefined;
  return (status, httpStatusOverride) => {
    if (status === "incomplete") {
      // Normal limit/content-filter/stall terminal — the account served the
      // request. Don't penalize account health; record success to clear any
      // prior soft-avoid so a healthy account isn't stuck avoided.
      recordCodexUpstreamOutcome(config, authCtx.accountId, 200, {
        threadId,
        modelId,
        probeLeaseId: codexProbeLeaseId(authCtx),
        probeQuotaScope: codexProbeQuotaScope(authCtx),
      });
      return;
    }
    // status === "completed" or "failed": use the semantic HTTP status derived
    // from the terminal SSE error payload (httpStatusFromTerminalError in
    // request-log inspection) instead of collapsing every non-completed terminal
    // to 502. A 400 invalid_request_error must not soft-avoid the account or
    // rebind threads — only genuine transport/5xx failures should trigger
    // transient health recording.
    // httpStatusOverride: the combo WS path inspects SSE payloads into the parent
    // logCtx, but this recorder closes over the child logCtx. The caller passes
    // the parent's terminalHttpStatus so the semantic status is not lost.
    const outcome = status === "completed"
      ? 200
      : (httpStatusOverride ?? logCtx?.terminalHttpStatus ?? 502);
    recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, {
      threadId,
      modelId,
      probeLeaseId: codexProbeLeaseId(authCtx),
      probeQuotaScope: codexProbeQuotaScope(authCtx),
    });
  };
}



export function decodeRequestErrorResponse(err: unknown, label: string): Response {
  if (err instanceof UnsupportedContentEncodingError) {
    return formatErrorResponse(415, "invalid_request_error", err.message);
  }
  if (err instanceof DecompressedBodyTooLargeError) {
    return formatErrorResponse(413, "invalid_request_error", err.message);
  }
  console.warn(`[${label}] request body decode/parse failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  return formatErrorResponse(400, "invalid_request_error", "Invalid JSON body");
}



export function comboUnavailableResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: "server_error", code: "combo_unavailable" },
    }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}



export interface ConsumedComboFailure {
  response: Response;
  classificationText: string;
  /** Structured upstream `error.code` when present in the failure body. */
  upstreamCode?: string;
  /** Valid numeric/date value used only for cooldown calculation. */
  retryAfter?: string;
  /** Reserved for 040 usage attribution without adding another body read. */
  usage?: OcxUsage;
}



export interface HandleResponsesOptions {
  forceEmptyResponseId?: boolean;
  abortSignal?: AbortSignal;
  /** One-shot TTFT callback: first non-empty model output observed (WP4). */
  onFirstOutput?: () => void;
  onCodexAuthContextResolved?: (context: CodexAuthContext | undefined) => void;
  recordTerminalOutcomes?: boolean;
  setTerminalOutcomeRecorder?: (recorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined) => void;
  onNativePassthroughTerminal?: (status: ResponsesTerminalStatus) => void;
  onNativePassthroughCancel?: () => void;
  /**
   * When true, body `prompt_cache_key` is a Claude Desktop shared cache cohort
   * (system/tools hash), not a per-session id — do not use it for Anthropic pool affinity.
   */
  promptCacheKeyIsSharedCohort?: boolean;
  /** Internal recursion guard; callers outside this module must not set it. */
  comboAttempt?: boolean;
  /**
   * Internal: this combo attempt belongs to a provider-fallback hop chain, not to a
   * combo the user configured. Such a hop must otherwise behave exactly like the plain request
   * it replaced, so single-provider behaviour that combos disable on purpose — currently the
   * Anthropic terminal-guard continuation — stays enabled.
   */
  providerFallbackAttempt?: boolean;
  /** Internal combo handoff: allow a later same-provider model after a reset-derived 429/402. */
  deferCodexResetDerivedCooldown?: boolean;
  /** 030-owned handoff when a child consumed the original failure under bounds. */
  onConsumedComboFailure?: (failure: ConsumedComboFailure) => void;
  /** Internal request-scoped physical upstream-send budget. */
  attemptBudget?: UpstreamAttemptBudget;
  /**
   * Live server config for disk writes when the routing `config` is a clone (provider-fallback
   * chain). Mutations still use the routing config; only `saveConfigPreservingClaudeCode` uses
   * this root so claudeCode hand-edit protection and combo maps stay on the live instance.
   */
  persistConfig?: OcxConfig;
}



export function clientCancelledResponse(): Response {
  return formatErrorResponse(499, "client_cancelled", "Client cancelled request");
}

const ADAPTER_MISSING_CREDENTIAL_MESSAGE =
  /requires a non-empty credential|requires a non-empty api\s*key|requires a non-empty apikey|\boauth token missing\b|\btoken missing\b|requires a Cursor access token|auth is required but unavailable/i;

function isAdapterMissingCredentialError(err: unknown, message: string): boolean {
  if (
    err instanceof CodexAuthContextError
    || err instanceof CodexPoolAuthenticationError
    || err instanceof CodexDirectAuthenticationError
    || err instanceof ForwardAdmissionCredentialError
  ) {
    return true;
  }
  if (
    typeof err === "object"
    && err !== null
    && "code" in err
    && (err as { code?: unknown }).code === "cursor_missing_credential"
  ) {
    return true;
  }
  return ADAPTER_MISSING_CREDENTIAL_MESSAGE.test(message);
}

function classifyAdapterBuildRequestError(
  err: unknown,
  abortSignal?: AbortSignal,
): { status: number; errorType: string; message: string } {
  if (
    abortSignal?.aborted
    || (err instanceof Error && err.name === "AbortError")
  ) {
    return { status: 499, errorType: "client_cancelled", message: "Client cancelled request" };
  }
  const message = redactSecretString(err instanceof Error ? err.message : String(err))
    .replace(/(https?:\/\/)[^/\s"'@]*@/g, "$1<redacted>@");
  const missingCred = isAdapterMissingCredentialError(err, message);
  return {
    status: missingCred ? 401 : 500,
    errorType: missingCred ? "authentication_error" : "server_error",
    message,
  };
}

/**
 * Adapter `buildRequest` throws on empty credentials (and similar config bugs).
 * Catching here keeps `/v1/messages` JSON instead of Bun's HTML 500 fallback,
 * which Claude Desktop 3P surfaces as a generic gateway failure.
 */
export function adapterBuildRequestError(err: unknown): Response {
  const { status, errorType, message } = classifyAdapterBuildRequestError(err);
  return formatErrorResponse(status, errorType, message);
}

/** Maps buildRequest throws to JSON responses; honors client abort as 499. */
export function resolveAdapterBuildRequestError(err: unknown, abortSignal?: AbortSignal): Response {
  const { status, errorType, message } = classifyAdapterBuildRequestError(err, abortSignal);
  return formatErrorResponse(status, errorType, message);
}



export function sanitizedRetryAfter(value: string | null, now: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  return parseRetryAfterMs(trimmed, now) !== undefined ? trimmed : undefined;
}



export async function consumeComboFailure(
  response: Response,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<ConsumedComboFailure> {
  const fallback = `Provider error ${response.status}`;
  let classificationText = fallback;
  let usage: OcxUsage | undefined;
  let upstreamCode: string | undefined;
  try {
    const body = await readBoundedResponseBody(response, { signal });
    usage = usageFromComboFailureText(body.text);
    if (body.displaySafe) {
      const safeText = redactSecretString(body.text).slice(0, 500);
      if (safeText) classificationText = safeText;
      try {
        const parsed = JSON.parse(body.text) as { error?: { code?: unknown } | string };
        const nested = typeof parsed?.error === "object" && parsed.error ? parsed.error.code : undefined;
        if (typeof nested === "string" && nested.length > 0) upstreamCode = nested;
      } catch {
        /* non-JSON upstream body — message-only classification */
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    classificationText = fallback;
  }
  const message = classificationText === fallback
    ? fallback
    : `${fallback}: ${classificationText}`;
  const upstreamRetryAfter = response.headers.get("retry-after");
  // Client response may get the synthetic "2" fallback; cooldown metadata must not —
  // otherwise coolComboTarget treats it as a 2s cooldown instead of the 60s default.
  const clientRetryAfter = resolveClientRetryAfter({
    status: response.status,
    message,
    upstreamRetryAfter,
    now,
  });
  const cooldownRetryAfter = resolveClientRetryAfter({
    status: response.status,
    message,
    upstreamRetryAfter,
    now,
    includeDefault: false,
  });
  return {
    response: formatErrorResponse(response.status, "upstream_error", message, {
      ...(upstreamCode !== undefined ? { code: upstreamCode } : {}),
      ...(clientRetryAfter !== undefined ? { retryAfter: clientRetryAfter } : {}),
    }),
    classificationText,
    ...(upstreamCode !== undefined ? { upstreamCode } : {}),
    ...(cooldownRetryAfter !== undefined ? { retryAfter: cooldownRetryAfter } : {}),
    ...(usage ? { usage } : {}),
  };
}



export function usageFromComboFailureText(text: string): OcxUsage | undefined {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const nested = payload.response;
    const source = nested && typeof nested === "object" && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : payload;
    return usageFromResponsesPayload(source.usage);
  } catch {
    return undefined;
  }
}



export function createChildPassthroughCallbackGate(options: HandleResponsesOptions) {
  type Pending =
    | { kind: "terminal"; status: ResponsesTerminalStatus }
    | { kind: "cancel" };
  let state: "pending" | "committed" | "discarded" = "pending";
  let pending: Pending | undefined;
  let accepted = false;
  const publish = (value: Pending): void => {
    if (value.kind === "terminal") options.onNativePassthroughTerminal?.(value.status);
    else options.onNativePassthroughCancel?.();
  };
  const receive = (value: Pending): void => {
    if (state === "discarded" || accepted) return;
    accepted = true;
    if (state === "committed") return publish(value);
    pending ??= value;
  };
  return {
    onTerminal: (status: ResponsesTerminalStatus) => receive({ kind: "terminal", status }),
    onCancel: () => receive({ kind: "cancel" }),
    commit: () => {
      if (state !== "pending") return;
      state = "committed";
      if (pending) publish(pending);
      pending = undefined;
    },
    discard: () => {
      state = "discarded";
      pending = undefined;
    },
  };
}



export function buildComboChildHeaders(parentHeaders: HeadersInit): Headers {
  const childHeaders = new Headers(parentHeaders);
  // Combo children re-serialize already-decoded JSON. Keeping transport metadata from
  // the parent would make the child decoder treat plain JSON as compressed bytes.
  childHeaders.delete("content-length");
  childHeaders.delete("content-encoding");
  return childHeaders;
}

const UNREADABLE_ENCRYPTED_AGENT_TASK_MESSAGE =
  "Routed V2 worker task is encrypted for the native ChatGPT backend and cannot be read by the selected provider. Use plaintext V2 agent-message delivery or select a native ChatGPT model.";

function unreadableEncryptedAgentTaskResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: UNREADABLE_ENCRYPTED_AGENT_TASK_MESSAGE,
        type: "invalid_request_error",
        code: "unreadable_encrypted_agent_task",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Apply every route-dependent request mutation against the final selected route.
 * Must run only after subagent fallback has settled the model/provider.
 */
async function applyFinalRouteRequestNormalization(args: {
  parsed: OcxParsedRequest;
  route: RouteResult;
  config: OcxConfig;
  req: Request;
  logCtx: RequestLogContext;
}): Promise<void> {
  const { parsed, route, config, req, logCtx } = args;

  // Apply the routed model id upstream: routing may strip a "<provider>/" namespace.
  if (route.modelId !== parsed.modelId) {
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as { model?: string }).model = route.modelId;
    }
    parsed.modelId = route.modelId;
  }
  // Settle the wire once so logging, fast-mode, auth, and sidecars read the adapter
  // this request will actually use (#404).
  route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
  logCtx.model = route.modelId;
  logCtx.provider = route.providerName;
  // `logCtx.provider` is later rewritten to a display label with a Codex account suffix; keep
  // the raw config key so cap-cooldown never disables an unrelated same-named provider.
  logCtx.providerConfigKey = route.providerName;
  logCtx.providerAdapter = route.provider.adapter;

  // Final selected model before virtual wire-model rewriting (Pro aliases).
  const finalSelectedModelId = route.modelId;

  // Virtual model rewriting: Pro aliases → base model + reasoning.mode="pro".
  applyOpenAiVirtualModel(parsed, route, logCtx);

  // Fast mode override for OpenAI-routed models.
  if (config.fastMode !== undefined && route.provider.adapter === "openai-responses") {
    const tier = config.fastMode ? "priority" : undefined;
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      if (tier) (parsed._rawBody as Record<string, unknown>).service_tier = tier;
      else delete (parsed._rawBody as Record<string, unknown>).service_tier;
    }
    parsed.options.serviceTier = tier;
  }

  {
    const guidance = await multiAgentGuidanceText(parsed, {
      multiAgentGuidanceEnabled: config.multiAgentGuidanceEnabled,
      injectionModel: config.injectionModel,
      injectionEffort: config.injectionEffort,
      subagentModels: config.subagentModels,
      subagentModelFallback: config.subagentModelFallback,
      injectionPrompt: config.injectionPrompt,
    });
    if (guidance) {
      injectDeveloperMessage(parsed, guidance);
      if (isInjectionDebugEnabled()) {
        injectionDebugLog(`[opencodex] ${route.modelId}: multi-agent guidance injected (surface=${collabSurface(parsed)}, guidanceEnabled=${multiAgentGuidanceEnabled(config)}, ${guidance.length} chars)`);
      }
    } else if (isInjectionDebugEnabled() && collabSurface(parsed) !== null) {
      injectionDebugLog(`[opencodex] ${route.modelId}: collab surface=${collabSurface(parsed)}, guidance silent (effort=${parsed.options.reasoning ?? "unset"}, injectionModel=${config.injectionModel ?? "unset"})`);
    }
  }

  {
    const { applyEffortCap, effortCapAppliesTo, supportedLadderFor } = await import("../effort-policy");
    const surface = collabSurface(parsed);
    if (effortCapAppliesTo(surface, req.headers, config, parsed._compactionRequest === true)) {
      const capped = applyEffortCap(parsed, req.headers, config, supportedLadderFor(route));
      if (capped) {
        logCtx.requestedEffort = `${capped.from}->${capped.to}`;
        if (isInjectionDebugEnabled()) {
          injectionDebugLog(`[opencodex] ${route.modelId}: effort cap applied (${capped.from} -> ${capped.to}, ${capped.subagent ? "sub-agent" : "main"} turn)`);
        }
      }
    } else if (isInjectionDebugEnabled() && (config.effortCap || config.subagentEffortCap)) {
      injectionDebugLog(`[opencodex] ${route.modelId}: effort cap skipped (surface=${surface ?? "none"}, v2 feature only)`);
    }
  }

  {
    const { nativeEffortClamp, shouldApplyNativeEffortClamp } = await import("../../codex/catalog");
    const clamped = shouldApplyNativeEffortClamp(route.providerName, route.provider, finalSelectedModelId)
      ? nativeEffortClamp(route.modelId, parsed.options.reasoning)
      : null;
    if (clamped) {
      parsed.options.reasoning = clamped;
      const raw = parsed._rawBody as { reasoning?: { effort?: string } } | undefined;
      if (raw?.reasoning && typeof raw.reasoning === "object") raw.reasoning.effort = clamped;
      logCtx.requestedEffort = `${logCtx.requestedEffort ?? "max"}->${clamped}`;
    }
  }
  recordAttemptRequestedEffort(logCtx);
  logCtx.modelSupportsServiceTier = catalogModelSupportsServiceTier(
    route.modelId,
    logCtx.requestedServiceTier ?? logCtx.configuredServiceTier,
  );
}



export async function handleComboResponses(
  req: Request,
  rawBody: unknown,
  comboId: string,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions,
): Promise<Response> {
  const requestedModel = typeof (rawBody as { model?: unknown } | null)?.model === "string"
    ? (rawBody as { model: string }).model
    : `combo/${comboId}`;
  // A per-provider fallback chain runs on this same hop loop but is not a combo the user
  // configured: the log row must keep the winning target's own provider/model rather than
  // collapsing into a synthetic `combo` row nothing in the GUI can open.
  const providerFallbackChain = options.providerFallbackAttempt === true
    || isProviderFallbackComboId(comboId);
  const comboIdentity = providerFallbackChain
    ? { requestedModel }
    : { requestedModel, model: requestedModel, provider: "combo", comboId };
  Object.assign(logCtx, comboIdentity);
  const combo = getCombo(config, comboId);
  if (!combo) {
    return formatErrorResponse(404, "invalid_request_error", `Unknown combo: ${comboIdLabel(comboId)}`);
  }
  const adoptFailedChildLog = (childLog: RequestLogContext): void => {
    // Attempts remain the complete physical history; the logical row mirrors the most recent
    // failed target so an exhausted combo still has useful top-level reasoning diagnostics.
    Object.assign(logCtx, childLog, {
      ...comboIdentity,
      attempts: logCtx.attempts,
      activeAttempt: undefined,
      activeAttemptStartedAt: undefined,
    });
  };

  const unreadableEncryptedAgentTask = hasUnreadableEncryptedAgentTask(
    (rawBody as { input?: unknown } | undefined)?.input,
  );
  const canDecryptUnreadableAgentTask = (target: (typeof combo.targets)[number]): boolean => {
    const provider = config.providers[target.provider];
    if (!provider || provider.disabled === true) return false;
    try {
      const route = routeModel(config, `${target.provider}/${target.model}`);
      return isCanonicalOpenAiForwardProvider(route.provider);
    } catch {
      return false;
    }
  };
  const payloadEligible = (target: (typeof combo.targets)[number]): boolean =>
    !unreadableEncryptedAgentTask || canDecryptUnreadableAgentTask(target);

  if (unreadableEncryptedAgentTask && !combo.targets.some(canDecryptUnreadableAgentTask)) {
    return unreadableEncryptedAgentTaskResponse();
  }

  const initialNow = Date.now();
  let pick = pickComboTarget(config, comboId, {
    eligible: target => payloadEligible(target)
      && !isComboTargetInCooldown(comboId, target, initialNow),
  });
  if (!pick) {
    return comboUnavailableResponse(`No available targets for combo: ${comboIdLabel(comboId)}`);
  }

  let lastFailure: Response | null = null;
  while (pick) {
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    if (options.attemptBudget?.remaining === 0) {
      return lastFailure ?? formatErrorResponse(
        502,
        "upstream_error",
        "OCX upstream attempt budget exhausted",
      );
    }
    const childLog: RequestLogContext = {
      model: pick.target.model,
      provider: pick.target.provider,
      ...(logCtx.conversationId ? { conversationId: logCtx.conversationId } : {}),
      ...(logCtx.surface ? { surface: logCtx.surface } : {}),
    };
    const targetRoute = routeModel(config, `${pick.target.provider}/${pick.target.model}`);
    const childBody = concreteComboRequestBody(
      rawBody,
      pick.target,
      comboDefaultEffort(config, comboId),
      supportedLadderFor({ provider: targetRoute.provider, modelId: targetRoute.modelId }),
    );
    const childHeaders = buildComboChildHeaders(req.headers);
    const childRequest = new Request(req.url, {
      method: req.method,
      headers: childHeaders,
      body: JSON.stringify(childBody),
    });
    let resolvedAuth: CodexAuthContext | undefined;
    let terminalRecorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined;
    const started = Date.now();
    const attempt = beginRequestAttempt(
      (logCtx.attempts?.length ?? 0) + 1,
      pick.target.provider,
      pick.target.model,
      config.providers[pick.target.provider]!.adapter,
    );
    childLog.activeAttempt = attempt;
    let attemptRetained = false;
    const retainCancelledAttempt = (): void => {
      if (attemptRetained) return;
      sealRequestAttemptIdentity(
        attempt,
        childLog.provider,
        childLog.providerAdapter ?? attempt.adapter,
      );
      finishRequestAttempt(attempt, 499, Date.now() - started, childLog.usage);
      (logCtx.attempts ??= []).push(attempt);
      attemptRetained = true;
    };
    let consumedChildFailure: ConsumedComboFailure | undefined;
    const callbackGate = createChildPassthroughCallbackGate(options);
    let response: Response;
    try {
      const currentTargetProvider = pick.target.provider;
      const deferCodexResetDerivedCooldown = combo.strategy === "failover"
        && combo.targets.slice(pick.targetIndex + 1).some(target =>
          target.provider === currentTargetProvider
          && payloadEligible(target)
          && !isComboTargetInCooldown(comboId, target),
        );
      response = await handleResponses(childRequest, config, childLog, {
        ...options,
        comboAttempt: true,
        // A synthetic fallback hop must keep the single-provider behaviour of the plain request
        // it stands in for; a user-configured combo keeps the stricter combo semantics.
        providerFallbackAttempt: providerFallbackChain,
        // Each combo target gets its own attempt budget. The shared budget bounds retries
        // against ONE upstream — transport retries plus account-pool rotation — but a combo
        // target is a different provider entirely, and the target list plus per-target
        // cooldowns already bound the fan-out. Sharing a single budget let a leading target's
        // transient retries (e.g. three 503s) consume it and starve the failover the combo
        // exists to perform, so the combo returned the first target's error instead of
        // advancing.
        attemptBudget: createUpstreamAttemptBudget(),
        deferCodexResetDerivedCooldown,
        // Attempt-relative TTFT is recorded HERE (not via childLog.firstOutputMs — a later
        // Object.assign(logCtx, childLog) would overwrite the request-relative value).
        onFirstOutput: () => {
          if (attempt.firstOutputMs === undefined) {
            attempt.firstOutputMs = Math.max(0, Date.now() - started);
          }
          options.onFirstOutput?.();
        },
        onCodexAuthContextResolved: value => { resolvedAuth = value; },
        setTerminalOutcomeRecorder: value => { terminalRecorder = value; },
        onConsumedComboFailure: value => { consumedChildFailure = value; },
        onNativePassthroughTerminal: callbackGate.onTerminal,
        onNativePassthroughCancel: callbackGate.onCancel,
      });
    } catch (error) {
      callbackGate.discard();
      if (options.abortSignal?.aborted) {
        retainCancelledAttempt();
        return clientCancelledResponse();
      }
      throw error;
    }

    if (options.abortSignal?.aborted) {
      callbackGate.discard();
      retainCancelledAttempt();
      return clientCancelledResponse();
    }

    if (response.ok) {
      sealRequestAttemptIdentity(
        attempt,
        childLog.provider,
        childLog.providerAdapter ?? attempt.adapter,
      );
      (logCtx.attempts ??= []).push(attempt);
      attemptRetained = true;
      noteComboSuccess(comboId, combo, pick.target);
      Object.assign(logCtx, childLog, {
        ...comboIdentity,
        attempts: logCtx.attempts,
        activeAttempt: attempt,
        activeAttemptStartedAt: started,
        resolvedModel: childLog.resolvedModel ?? childLog.model,
      });
      options.onCodexAuthContextResolved?.(resolvedAuth);
      options.setTerminalOutcomeRecorder?.(terminalRecorder);
      callbackGate.commit();
      return response;
    }

    callbackGate.discard();
    if (response.status === 499) {
      retainCancelledAttempt();
      return clientCancelledResponse();
    }
    let failure: ConsumedComboFailure;
    try {
      failure = consumedChildFailure
        ?? await consumeComboFailure(response, options.abortSignal);
    } catch (error) {
      if (options.abortSignal?.aborted) {
        retainCancelledAttempt();
        return clientCancelledResponse();
      }
      throw error;
    }
    if (options.abortSignal?.aborted) {
      retainCancelledAttempt();
      return clientCancelledResponse();
    }
    sealRequestAttemptIdentity(
      attempt,
      childLog.provider,
      childLog.providerAdapter ?? attempt.adapter,
    );
    finishRequestAttempt(
      attempt,
      response.status,
      Date.now() - started,
      failure.usage,
    );
    (logCtx.attempts ??= []).push(attempt);
    attemptRetained = true;
    lastFailure = failure.response;
    if (classifyAttempt({
      status: failure.response.status,
      message: failure.classificationText,
      code: failure.upstreamCode,
    }) === "surface") {
      adoptFailedChildLog(childLog);
      return lastFailure;
    }
    console.warn(
      `[combo] ${comboIdLabel(comboId)}: ${targetKey(pick.target)} failed with ${response.status} after ${Date.now() - started}ms`,
    );
    const nextPick = advanceComboAfterFailure(config, pick, {
      retryAfter: failure.retryAfter,
      now: Date.now(),
      eligible: payloadEligible,
    });
    if (!nextPick) adoptFailedChildLog(childLog);
    pick = nextPick;
  }
  return lastFailure!;
}



/**
 * Processes a Responses API request through routing, authentication, provider failover, sidecars,
 * streaming or non-streaming adaptation, continuation handling, and response normalization.
 *
 * @param req - The incoming HTTP request.
 * @param config - Server and provider configuration.
 * @param logCtx - Request context updated with routing, provider, usage, and response metadata.
 * @param options - Request lifecycle, retry, cancellation, and callback settings.
 * @returns The normalized Responses API response.
 */
export async function handleResponses(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions = {},
): Promise<Response> {
  if (!options.attemptBudget) {
    options = { ...options, attemptBudget: createUpstreamAttemptBudget() };
  }
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (err) {
    return decodeRequestErrorResponse(err, "responses");
  }
  const comboId = !options.comboAttempt ? comboIdFromRawBody(body, config) : null;
  if (comboId && Object.hasOwn(config.combos ?? {}, comboId)) {
    return handleComboResponses(req, body, comboId, config, logCtx, options);
  }
  const unreadableEncryptedAgentTask = hasUnreadableEncryptedAgentTask(
    (body as { input?: unknown } | undefined)?.input,
  );
  const originalBody = body;
  body = expandPreviousResponseInput(body);
  const previousResponseInputExpanded = body !== originalBody;

  // Spawn-message compatibility (both directions): agent_message task payloads ride in
  // encrypted_content slots as plaintext. Rewrite them to input_text on the RAW body BEFORE
  // parsing so every consumer sees the payload: parseRequest (routed/translated providers read
  // the parsed messages) and the native passthrough (_rawBody is this same object, serialized
  // verbatim). Genuine backend ciphertext is left byte-identical (looksLikeBackendCiphertext).
  {
    const rewritten = sanitizeEncryptedContentInPlace(
      (body as { input?: unknown } | undefined)?.input,
    );
    if (rewritten > 0)
      console.warn(
        `[opencodex] rewrote ${rewritten} plaintext encrypted_content part(s) to input_text (spawn-message compatibility)`,
      );
  }

  let parsed;
  try {
    parsed = parseRequest(body);
    if (previousResponseInputExpanded) parsed._previousResponseInputExpanded = true;
    parsed._providerContinuation = previousResponseProviderState(parsed.previousResponseId);
    parsed._cursorConversationId = parsed._providerContinuation?.cursor?.conversationId;
    const clientThreadId = req.headers.get("x-codex-parent-thread-id")?.trim();
    if (clientThreadId) parsed._clientThreadId = clientThreadId;
  } catch (err) {
    const rawModel = (body as { model?: unknown } | null)?.model;
    if (typeof rawModel === "string" && rawModel.trim()) {
      logCtx.requestedModel = rawModel.trim();
      logCtx.model = rawModel.trim();
    }
    return formatErrorResponse(400, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }
  // Prefer a pre-populated id (routed Claude) over Responses headers that may be
  // absent or synthetically injected (session_id from prompt_cache_key).
  if (!logCtx.conversationId) {
    logCtx.conversationId = conversationIdFromResponsesRequest({
      clientThreadId: parsed._clientThreadId,
      sessionIdHeader: sessionIdHeaderFromRequest(req.headers),
      threadIdHeader: req.headers.get("thread-id"),
      cursorConversationId: parsed._cursorConversationId,
    });
  }
  logCtx.requestedModel = parsed.modelId;
  logCtx.requestedEffort = parsed.options.reasoning;
  logCtx.requestedServiceTier = parsed.options.serviceTier;
  logCtx.requestedSpeedLabel = requestLogSpeedLabel(parsed.options.serviceTier);
  logCtx.configuredServiceTier = readConfiguredCodexServiceTier();
  logCtx.configuredSpeedLabel = requestLogSpeedLabel(logCtx.configuredServiceTier);

  // Shadow call intercept: rewrite Codex's hard-coded helper calls
  // (gpt-5.4-mini on older clients, gpt-5.6-luna on 0.145.0+)
  const _sci = config.shadowCallIntercept;
  if (_sci?.enabled && _sci.model && isShadowSourceModel(parsed.modelId, _sci.sourceModels)) {
    const _sciOriginal = parsed.modelId;
    parsed.modelId = _sci.model;
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as { model?: string }).model = _sci.model;
    }
    // Force effort to low for shadow/helper calls (matching upstream behavior)
    parsed.options.reasoning = "low";
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as Record<string, unknown>).reasoning = { effort: "low" };
    }
    (logCtx as unknown as Record<string, unknown>).shadowCallRewrittenFrom = _sciOriginal;
    // Helpers must not resume/append into the parent thread's Cursor conversation.
    parsed._cursorIsolateConversation = true;
  }
  if (parsed._compactionRequest === true) parsed._cursorIsolateConversation = true;

  let route: RouteResult;
  try {
    route = routeModel(config, parsed.modelId);
  } catch (err) {
    if (err instanceof NoAvailableComboTargetsError) {
      return comboUnavailableResponse(err.message);
    }
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }
  logCtx.model = route.modelId;
  logCtx.provider = route.providerName;
  logCtx.providerConfigKey = route.providerName;
  logCtx.providerAdapter = route.provider.adapter;

  const persistConfig = options.persistConfig ?? config;

  const hasUnexpandedPreviousResponse = !!parsed.previousResponseId
    && parsed._previousResponseInputExpanded !== true;
  // A canonical replay miss must not poll quota upstream before the final fail-closed decision.
  // Cached fallback state can still select a provider with native continuation support below.
  if (
    isThreadSpawnRequest(req.headers)
    && !(hasUnexpandedPreviousResponse && isCanonicalOpenAiForwardProvider(route.provider))
  ) {
    await maybePrimeSubagentQuota(config);
  }

  // Per-provider fallback replays the request across the provider's configured targets using the
  // combo hop loop. Thread spawns are excluded: they carry their own Codex account/model fallback
  // below, which the combo path deliberately skips.
  if (!options.comboAttempt && !isThreadSpawnRequest(req.headers)) {
    const chain = selectHopChain(config, { provider: route.providerName, modelId: route.modelId });
    if (chain) {
      // Hand the hop loop the PRE-expansion body, exactly as the `combo/<id>` entry point does.
      // `expandPreviousResponseInput` is not idempotent and leaves `previous_response_id` in
      // place, so replaying an already-expanded body would prepend the restored history a second
      // time in every child request.
      return handleComboResponses(req, originalBody, chain.comboId, chain.config, logCtx, {
        ...options,
        providerFallbackAttempt: chain.preservePhysicalIdentity,
        persistConfig: options.persistConfig ?? config,
      });
    }
  }

  let authCtx: CodexAuthContext = { kind: "main", accountId: null };
  let selectedForwardHeaders = req.headers;
  let subagentFallbackAccountId = config.activeCodexAccountId ?? null;
  let subagentQuotaFailureModel = parsed.modelId;

  // Subagent fallback must settle the final model/provider BEFORE route-dependent
  // normalization (virtual models, effort caps, service tier, wire protocol).
  // Preview the preferred Codex account without acquiring a probe lease or refreshing
  // tokens — auth is resolved only after the final route is selected.
  if (isThreadSpawnRequest(req.headers) && !options.comboAttempt) {
    const threadId = req.headers.get("x-codex-parent-thread-id");
    const previewAccountId = previewCodexAccountForRequest(threadId, config);
    subagentFallbackAccountId = previewAccountId ?? config.activeCodexAccountId ?? null;
    const fallback = applySubagentModelFallback(
      parsed,
      req.headers,
      config,
      previewAccountId,
      Date.now(),
      unreadableEncryptedAgentTask,
    );
    if (fallback) {
      (logCtx as unknown as Record<string, unknown>).subagentModelFallbackFrom = fallback.from;
      (logCtx as unknown as Record<string, unknown>).subagentModelFallbackTo = fallback.to;
      if (isInjectionDebugEnabled()) {
        injectionDebugLog(`[opencodex] subagent model fallback ${fallback.from} -> ${fallback.to}`);
      }
    }
    subagentQuotaFailureModel = fallback?.to ?? parsed.modelId;

    if (fallback?.to && !slugsEquivalent(fallback.to, route.modelId)) {
      try {
        route = routeModel(config, fallback.to);
      } catch (err) {
        if (err instanceof NoAvailableComboTargetsError) {
          return comboUnavailableResponse(err.message);
        }
        return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Encrypted child tasks may only reach the canonical native backend. This check
  // runs against the FINAL route so native-only fallback can rescue a routed primary.
  if (!isCanonicalOpenAiForwardProvider(route.provider) && unreadableEncryptedAgentTask) {
    return unreadableEncryptedAgentTaskResponse();
  }

  // The canonical ChatGPT backend rejects previous_response_id, so a local replay miss leaves no
  // safe way to recover the omitted history. Fail before auth, adapter construction, or upstream
  // I/O instead of stripping the id and silently forwarding a context-free delta (#702).
  if (
    hasUnexpandedPreviousResponse
    && isCanonicalOpenAiForwardProvider(route.provider)
  ) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "OpenAI forward continuation state is unavailable or expired; start a new session instead of reusing this previous_response_id.",
    );
  }

  await applyFinalRouteRequestNormalization({ parsed, route, config, req, logCtx });

  if (route.codexAccountMode === "direct") {
    try {
      validateForwardAdmissionCredential(req.headers, config);
    } catch (err) {
      if (err instanceof ForwardAdmissionCredentialError) {
        return formatErrorResponse(401, "authentication_error", err.message);
      }
      throw err;
    }
  }

  // Availability first-picks the fetch-ready candidate (Codex, OAuth pool,
  // ChefVault lease, key pool). Session keys are request evidence, not adapter choice.
  // Direct admission (caller credential present) stays on the turn.
  const isOAuth401ReplayProvider = (route.providerName === "xai" || route.providerName === "github-copilot" || route.providerName === "kiro")
    && route.provider.authMode === "oauth";
  let sentOAuthSnapshot: OAuthAccessSnapshot | undefined;
  let anthropicPoolAccountId: string | null = null;
  let anthropicPoolFailovers = 0;
  let googleAntigravityPoolAccountId: string | null = null;
  let googleAntigravityPoolFailovers = 0;
  let cursorPoolAccountId: string | null = null;
  let cursorPoolFailovers = 0;
  const anthropicSessionKey = route.providerName === "anthropic" && route.provider.authMode === "oauth"
    ? anthropicSessionKeyFromParts({
      sessionIdHeader: sessionIdHeaderFromRequest(req.headers),
      threadIdHeader: req.headers.get("thread-id"),
      promptCacheKey: typeof parsed.options.promptCacheKey === "string" ? parsed.options.promptCacheKey : null,
      clientThreadId: typeof parsed._clientThreadId === "string" ? parsed._clientThreadId : null,
      promptCacheKeyIsSharedCohort: options.promptCacheKeyIsSharedCohort === true,
    })
    : null;
  const antigravitySessionKey = route.providerName === "google-antigravity"
    && route.provider.authMode === "oauth"
    ? googleAntigravitySessionKey(parsed)
    : null;
  const antigravityPoolOwns429 = route.providerName === "google-antigravity"
    && isGoogleAntigravityAccountPoolEnabled(config);
  const cursorSessionKey = route.providerName === "cursor" && route.provider.authMode === "oauth"
    ? cursorSessionKeyFromParts({
      clientThreadId: parsed._clientThreadId,
      sessionIdHeader: sessionIdHeaderFromRequest(req.headers),
      threadIdHeader: req.headers.get("thread-id"),
      promptCacheKey: parsed.options.promptCacheKey,
      cursorConversationId: parsed._cursorConversationId,
    })
    : null;
  const pick = await selectCandidate({
    providerName: route.providerName,
    config,
    routedProvider: route.provider,
    sessionKey: route.providerName === "anthropic"
      ? anthropicSessionKey
      : route.providerName === "google-antigravity"
        ? antigravitySessionKey
        : route.providerName === "cursor"
          ? cursorSessionKey
          : null,
    promptCacheKey: parsed.options.promptCacheKey,
    headers: req.headers,
    mode: route.codexAccountMode,
    modelId: route.modelId,
  });
  if (!pick.ok) return selectCandidateFailResponse(pick, { providerName: route.providerName, config });
  route.provider = pick.provider;
  authCtx = pick.authCtx ?? { kind: "main", accountId: null };
  selectedForwardHeaders = pick.headers ?? req.headers;
  options.onCodexAuthContextResolved?.(route.codexAccountMode ? pick.authCtx : undefined);
  logCtx.provider = formatCodexProviderForLog(route.providerName, codexLogAccountId(authCtx), config);
  // Prefer Codex pool account as the Cursor thread namespace when present. Cursor routes without
  // codexAccountMode still get a credential-derived scope inside the Cursor adapter.
  const identityScope = codexLogAccountId(authCtx);
  if (identityScope) parsed._cursorIdentityScope = identityScope;
  subagentFallbackAccountId = authCtx.kind === "pool" || authCtx.kind === "main-pool"
    ? authCtx.accountId
    : config.activeCodexAccountId ?? null;
  if (pick.logProvider) logCtx.provider = pick.logProvider;
  if (pick.oauthPool?.pool === "anthropic") anthropicPoolAccountId = pick.oauthPool.accountId;
  else if (pick.oauthPool?.pool === "google-antigravity") googleAntigravityPoolAccountId = pick.oauthPool.accountId;
  else if (pick.oauthPool?.pool === "cursor") {
    cursorPoolAccountId = pick.oauthPool.accountId;
    parsed._cursorIdentityScope = pick.oauthPool.accountId;
  }
  if (isOAuth401ReplayProvider && pick.oauthSnapshot) sentOAuthSnapshot = pick.oauthSnapshot;
  if (route.providerName === "kiro" && pick.oauthSnapshot) {
    // `{}` is intentional: this is an account-scoped request with no stored routing metadata.
    parsed._kiroAuthContext = { ...(pick.oauthSnapshot.kiro ?? {}) };
  }
  const adapterProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
  const adapter = resolveAdapter(adapterProvider, config.cacheRetention);
  logCtx.providerAdapter = adapter.name;
  sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, adapter.name);
  const persistHardCap = async (response: Response): Promise<void> => {
    if (response.status !== 429 && response.status !== 402) return;
    recordCapOutcome({
      config,
      persistConfig,
      providerName: route.providerName,
      status: response.status,
      message: await peekUpstreamErrorText(response, options.abortSignal),
    });
  };
  const isPassthrough = "passthrough" in adapter && !!adapter.passthrough;

  if (adapter.name === "kiro" && parsed.previousResponseId && !parsed._previousResponseInputExpanded) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "Kiro continuation state is missing; start a new session instead of reusing this previous_response_id.",
    );
  }

  let openAiSidecar: ResolvedOpenAiForwardSidecar | undefined;
  const needsOpenAiVision = shouldResolveOpenAiVisionSidecar(config, route.provider, route.modelId, parsed);
  const needsOpenAiSearch = shouldResolveOpenAiWebSearchSidecar(config, parsed, isPassthrough);
  if (needsOpenAiVision || needsOpenAiSearch) {
    try {
      openAiSidecar = await resolveFirstUsableOpenAiSidecar(
        listOpenAiForwardSidecarCandidates(config),
        req.headers,
        config,
      );
    } catch (err) {
      // Sidecars are optional helpers for an otherwise independent routed turn.
      // An unavailable/cooling/expired Multi credential disables the helper; it
      // must not turn a valid routed-provider request into a Codex-auth failure.
      if (
        !(err instanceof CodexPoolAuthenticationError)
        && !(err instanceof CodexAuthContextError)
        && !(err instanceof CodexAccountCooldownError)
        && !(err instanceof CodexThreadAffinityExpiredError)
      ) throw err;
    }
  }

  // Vision sidecar: the routed model can't see images (provider.noVisionModels). Describe each
  // attached image through the selected sidecar backend and replace it with text BEFORE the main
  // call, so the text-only model can reason about it.
  const visionPlan = planVisionSidecar(config, route.provider, route.modelId, parsed, openAiSidecar);
  const recordSidecarOutcome = openAiSidecar?.recordOutcome;
  if (visionPlan) {
    await describeImagesInPlace(parsed, visionPlan, openAiSidecar?.headers ?? selectedForwardHeaders, options.abortSignal, recordSidecarOutcome);
  } else if (modelInList(route.provider.noVisionModels, route.modelId)) {
    // Sidecar-covered model but NO plan (no forward provider / missing forwarded auth / sidecar
    // disabled): fail closed — never forward raw images to a text-only upstream.
    stripImagesInPlace(parsed);
  }

  const recordTerminalOutcomes = options.recordTerminalOutcomes !== false;

  const continuationStateForResponse = (
    emitted?: OcxProviderContinuationState,
  ): OcxProviderContinuationState | undefined => {
    const cursorConversationId = parsed._cursorConversationId;
    const inherited = parsed._providerContinuation;
    if (!emitted && !inherited && !cursorConversationId) return undefined;
    return {
      ...(inherited ?? {}),
      ...(emitted ?? {}),
      ...((inherited?.kiro || emitted?.kiro)
        ? { kiro: { ...(inherited?.kiro ?? {}), ...(emitted?.kiro ?? {}) } }
        : {}),
      ...(cursorConversationId
        ? {
            cursor: {
              ...(inherited?.cursor ?? {}),
              ...(emitted?.cursor ?? {}),
              conversationId: cursorConversationId,
            },
          }
        : {}),
    };
  };

  // Remote compaction v2 on a ROUTED model: Codex sent `compaction_trigger` and requires exactly
  // one `{type:"compaction"}` output item (codex-rs compact_remote_v2.rs). Passthrough handles it
  // natively upstream; here we run the routed model as a plain summarizer — no tools, no web-search
  // sidecar — and the bridge appends the synthetic compaction item (src/responses/compaction.ts).
  // A Responses-shaped wire does not imply support for Codex's private
  // `compaction_trigger` item — only the canonical ChatGPT backend speaks that
  // contract. An API-key gateway would receive the trigger, answer with an ordinary
  // message, and leave Codex fataling on a missing compaction item (#422).
  const routedCompaction = parsed._compactionRequest === true
    && !isCanonicalOpenAiForwardProvider(route.provider);
  if (routedCompaction) {
    delete parsed.context.tools;
    delete parsed._webSearch;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  if ("passthrough" in adapter && adapter.passthrough && !routedCompaction) {
    const imageGenCallAliases = route.provider.authMode === "forward"
      ? new Map<string, { namespace: string; name: string }>()
      : imageGenToolCallAliases(buildToolBridgeMaps(parsed).toolNsMap, parsed._rawBody);
    // Local continuation cache for the ChatGPT passthrough. Codex WS turns chain with
    // previous_response_id, ocx converts them to internal HTTP requests, and the ChatGPT Codex
    // REST backend rejects the parameter — the adapter strips it in forward mode, so the ONLY
    // way a chained turn keeps its earlier context is the local replay expansion. Record
    // completed passthrough responses (force bypasses Codex's blanket store:false) so the next
    // turn's expansion hits. Never record a body whose own previous_response_id failed to
    // expand: its input is a delta, and storing it would replay a truncated conversation.
    // Compaction turns are excluded: _rawBody still carries the full pre-compaction history and
    // recording it would let a later expansion rehydrate the chain Codex just replaced.
    const passthroughRecordEligible = parsed._compactionRequest !== true
      && (!parsed.previousResponseId || parsed._previousResponseInputExpanded === true);
    const rememberPassthroughResponse = passthroughRecordEligible
      ? (response: { id?: unknown; output?: unknown; status?: unknown }) =>
        rememberResponseState(parsed._rawBody, response, undefined, { force: true })
      : undefined;
    if (parsed.previousResponseId && !parsed._previousResponseInputExpanded) {
      console.warn(
        `[responses] previous_response_id ${parsed.previousResponseId} not found in local replay state `
        + `(model ${parsed.modelId}); forwarding without it — earlier turns may be missing from this request`,
      );
    }
    let request: AdapterRequest;
    try {
      request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders });
    } catch (err) {
      return resolveAdapterBuildRequestError(err, options.abortSignal);
    }
    recordAdapterReasoning(logCtx, request);
    const passthroughEstimate = typeof request.usageLog?.inputTokens === "number"
      ? request.usageLog.inputTokens
      : undefined;
    if (passthroughEstimate !== undefined) {
      logCtx.usageLogInputTokens = passthroughEstimate;
    }
    // Abort the upstream if the client disconnects. A directly-relayed body does not propagate the
    // consumer's cancel to a signalled fetch, so we pass the signal and relay through relayWithAbort,
    // whose cancel() aborts the upstream — preventing leaked connections (RC2, passthrough path).
    const upstream = new AbortController();
    linkAbortSignal(upstream, options.abortSignal);
    const connectMs = config.connectTimeoutMs ?? 200_000;
    // Jittered inter-request pacing for outbound Codex pool calls. No-op when
    // disabled (default) or for non-pool auth (main passthrough / other providers).
    // The linked upstream signal makes a queued wait abortable: a client
    // disconnect stops the pacing wait and we bail before the upstream fetch.
    if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
      await codexPaceBeforeSend(config, authCtx.accountId, configuredCodexPoolSize(config), upstream.signal);
      if (upstream.signal.aborted) return clientCancelledResponse();
    }
    let upstreamResponse: Response;
    const transportFailureResponse = (err: unknown): Response => {
      upstream.abort();
      if (options.abortSignal?.aborted) return clientCancelledResponse();
      const outcome = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "connect_error";
      if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
        recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, {
          threadId: req.headers.get("x-codex-parent-thread-id"),
          modelId: route.modelId,
          probeLeaseId: codexProbeLeaseId(authCtx),
          probeQuotaScope: codexProbeQuotaScope(authCtx),
        });
      }
      const msg = outcome === "timeout"
        ? `Provider connect timeout after ${connectMs}ms`
        : describeUpstreamConnectFailure(err, connectMs);
      return formatErrorResponse(502, "upstream_error", msg);
    };
    try {
      // Transient-5xx pre-stream retry (devlog/_plan/260716_claudecode_hardening/010):
      // the ChatGPT backend emits transient 502/520s that an immediate retry absorbs.
      // Body is a replayable string; nothing has streamed to the client yet.
      upstreamResponse = await fetchWithTransientRetry(
        recovery => {
          noteAttemptSend(logCtx.activeAttempt, passthroughEstimate, recovery);
          return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
            method: request.method,
            headers: request.headers,
            body: request.body,
          }, recovery), upstream.signal, connectMs, parsed.stream, providerFetch(route.provider));
        },
        {
          abortSignal: upstream.signal,
          label: safeHostLabel(request.url),
          attemptBudget: options.attemptBudget,
        },
      );
    } catch (err) {
      return transportFailureResponse(err);
    }

    if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
      let poolRetryOutcome: number | undefined;
      if (await shouldRetryCodexPoolAccountModel400(
        upstreamResponse,
        route.modelId,
        options.abortSignal,
      )) {
        poolRetryOutcome = 400;
      } else if (await shouldRetryCodexPoolAccountQuota(
        upstreamResponse,
        options.abortSignal,
      )) {
        // Pre-stream only: once SSE has begun, mid-stream quota stays terminal.
        poolRetryOutcome = upstreamResponse.status;
      }

      if (poolRetryOutcome !== undefined) {
        const retry = await retryCodexPoolOnAlternateAccount({
          req,
          config,
          route,
          parsed,
          logCtx,
          options,
          firstAuthCtx: authCtx,
          firstResponse: upstreamResponse,
          outcomeStatus: poolRetryOutcome,
          upstream,
          connectMs,
          passthroughEstimate,
          stream: parsed.stream,
        });
        if (retry.kind === "transport") {
          authCtx = retry.authCtx;
          return transportFailureResponse(retry.error);
        }
        if (retry.kind === "build-request-failed") {
          return retry.response;
        }
        if (retry.kind === "retried") {
          authCtx = retry.authCtx;
          request = retry.request;
          upstreamResponse = retry.upstreamResponse;
          selectedForwardHeaders = retry.selectedForwardHeaders;
          // Keep subagent quota-failure health keyed to the account that actually served.
          subagentFallbackAccountId = retry.authCtx.accountId;
        }
      }
    }
    const headers = sanitizePassthroughHeaders(upstreamResponse.headers);
    const resolvedModel = headers.get("openai-model")?.trim();
    if (resolvedModel) logCtx.resolvedModel = resolvedModel;
    if (isUsageDebugEnabled()) {
      const upstreamContentType = upstreamResponse.headers.get("content-type");
      if (upstreamContentType) logCtx.usageDebugContentType = upstreamContentType;
    }
    // The chatgpt backend may omit Content-Type on SSE responses. Fall back to
    // treating a successful body as SSE when the caller requested streaming.
    const passthroughCt = headers.get("content-type")?.toLowerCase();
    const isEventStream = passthroughCt?.includes("text/event-stream")
      || (upstreamResponse.ok && !!upstreamResponse.body && !passthroughCt && parsed.stream);
    const terminalRecorder = codexForwardTerminalOutcomeRecorder(
      config,
      authCtx,
      route.provider,
      route.modelId,
      logCtx,
      req.headers.get("x-codex-parent-thread-id"),
    );
    const terminalBodyWillRecord = !!terminalRecorder && upstreamResponse.ok && isEventStream;
    // Capture quota from upstream response for multi-account tracking
   if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
      // primary was the 5h window; it now carries weekly data for GPT plans.
      // Prefer primary when present, fall back to secondary for compatibility.
      const quotaMeta = codexQuotaOutcomeMeta(upstreamResponse);
      const { applyAccountQuotaFromUpstreamHeaders } = await import("../../codex/auth-api");
      applyAccountQuotaFromUpstreamHeaders(authCtx.accountId, upstreamResponse.headers);
      if (terminalBodyWillRecord) {
        options.setTerminalOutcomeRecorder?.((status, httpStatusOverride) => {
          terminalRecorder(status, httpStatusOverride);
          if (status === "failed") {
            const quotaFailureMessage = httpStatusOverride === 429 || httpStatusOverride === 402
              || logCtx.terminalHttpStatus === 429
              || logCtx.terminalHttpStatus === 402
              ? (httpStatusOverride ?? logCtx.terminalHttpStatus)
              : undefined;
            if (quotaFailureMessage !== undefined) {
              recordSubagentQuotaFailureForThreadSpawn(
                req.headers,
                subagentQuotaFailureModel,
                quotaFailureMessage,
                config,
                subagentFallbackAccountId,
              );
            }
          }
          options.onNativePassthroughTerminal?.(status);
        });
      } else if (!shouldDeferCodexResetDerivedCooldown(
        upstreamResponse,
        options.deferCodexResetDerivedCooldown,
      )) {
        recordCodexUpstreamOutcome(config, authCtx.accountId, upstreamResponse.status, {
          ...quotaMeta,
          threadId: req.headers.get("x-codex-parent-thread-id"),
          modelId: route.modelId,
          probeLeaseId: codexProbeLeaseId(authCtx),
          probeQuotaScope: codexProbeQuotaScope(authCtx),
        });
      }
    }

    // Non-2xx passthrough failures must never reach Codex as an empty body —
    // Codex renders that as the opaque "Unknown error" (#452). Combo attempts
    // keep their typed failure envelope. Non-empty bodies are relayed verbatim
    // (headers included) so pool-retry Activation B/D and client diagnostics stay intact.
    if (!upstreamResponse.ok) {
      if (options.comboAttempt) {
        const failure = await consumeComboFailure(upstreamResponse, options.abortSignal);
        options.onConsumedComboFailure?.(failure);
        return failure.response;
      }
      const errorText = await upstreamResponse.text().catch(() => "");
      return formatPassthroughUpstreamError(upstreamResponse.status, errorText, {
        statusText: upstreamResponse.statusText,
        headers,
      });
    }

    // Bun#32111 workaround: passthrough SSE uses tee()+native relay to avoid the
    // async-pull segfault on Windows. Branch[0] goes directly to the Response (Bun
    // native relay, never enters JS Sink.write); branch[1] is consumed in the
    // background for terminal-outcome/quota inspection only.
    // #314 alternative shape: on win32 (no repair) with a runtime carrying the
    // Bun#32111 fix — or explicit `streamMode: "eager-relay"` opt-in — the tee
    // is skipped entirely and relaySseEagerBounded provides a single eager
    // bounded reader with inline inspection (see src/server/relay-eager.ts and
    // devlog/_plan/260723_win_mem_safestream/020). Default on the bundled
    // known-bad runtime remains the tee path below.
    if (isEventStream && upstreamResponse.body) {
      const repairConfig = route.provider.responsesItemIdRepair;
      const needsClientRewrite = imageGenCallAliases.size > 0 || hasResponsesItemIdRepair(repairConfig);
      const winNoClientRewrite = process.platform === "win32" && !needsClientRewrite;
      const eagerDecision = winNoClientRewrite ? decideEagerRelay(config.streamMode ?? "auto") : null;
      if (eagerDecision?.useEagerRelay) {
        const turnAc = new AbortController();
        linkAbortSignal(upstream, turnAc.signal);
        registerTurn(turnAc);
        const reportNativeTerminal = recordTerminalOutcomes
          ? (status: ResponsesTerminalStatus, httpStatusOverride?: number) => {
            terminalRecorder?.(status, httpStatusOverride);
            if (status === "failed") {
              const quotaFailureMessage = httpStatusOverride === 429 || httpStatusOverride === 402
                || logCtx.terminalHttpStatus === 429
                || logCtx.terminalHttpStatus === 402
                ? (httpStatusOverride ?? logCtx.terminalHttpStatus)
                : undefined;
              if (quotaFailureMessage !== undefined) {
                recordSubagentQuotaFailureForThreadSpawn(
                  req.headers,
                  subagentQuotaFailureModel,
                  quotaFailureMessage,
                  config,
                  subagentFallbackAccountId,
                );
              }
            }
            options.onNativePassthroughTerminal?.(status);
          }
          : undefined;
        const inspector = createSseInspector({
          onTerminal: reportNativeTerminal,
          logCtx,
          onCompletedResponse: rememberPassthroughResponse,
          onFirstOutput: options.onFirstOutput,
        });
        const eagerBody = relaySseEagerBounded(upstreamResponse.body, turnAc, {
          inspectChunk: chunk => inspector.feed(chunk),
          finishInspection: () => inspector.finish(),
          sawTerminal: () => inspector.reported(),
          onSynthetic: kind => {
            if (!reportNativeTerminal) return;
            if (kind === "incomplete") {
              logCtx.terminalSource = "synthetic";
              reportNativeTerminal("incomplete");
            } else {
              logCtx.transportPhase = "mid_stream";
              logCtx.terminalSource = "synthetic";
              reportNativeTerminal("failed", 502);
            }
          },
          onClientCancel: () => options.onNativePassthroughCancel?.(),
          onDone: () => unregisterTurn(turnAc),
        });
        // The eager branch is reachable only through winNoClientRewrite, so it must stay a pure
        // native relay without an image-gen or item-id JS pull wrapper on win32 (Bun#32111).
        if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
        return markNativePassthroughSseResponse(new Response(eagerBody, {
          status: upstreamResponse.status,
          headers,
        }));
      }
      const [nativeBody, inspectBody] = upstreamResponse.body.tee();
      const turnAc = new AbortController();
      linkAbortSignal(upstream, turnAc.signal);
      registerTurn(turnAc);
      if (recordTerminalOutcomes) {
        // A real terminal was parsed from the (teed) inspection stream — record it as the outcome
        // even if the client has already disconnected: the turn genuinely reached that terminal, so
        // it must log as completed/failed, not be dropped or downgraded to a cancel (#44). A pure
        // client-cancel (no terminal seen) is finalized separately via consumeForInspection's onCancel.
        const reportNativeTerminal = (status: ResponsesTerminalStatus, httpStatusOverride?: number) => {
          terminalRecorder?.(status, httpStatusOverride);
          if (status === "failed") {
            const quotaFailureMessage = httpStatusOverride === 429 || httpStatusOverride === 402
              || logCtx.terminalHttpStatus === 429
              || logCtx.terminalHttpStatus === 402
              ? (httpStatusOverride ?? logCtx.terminalHttpStatus)
              : undefined;
            if (quotaFailureMessage !== undefined) {
              recordSubagentQuotaFailureForThreadSpawn(
                req.headers,
                subagentQuotaFailureModel,
                quotaFailureMessage,
                config,
                subagentFallbackAccountId,
              );
            }
          }
          options.onNativePassthroughTerminal?.(status);
        };
        consumeForInspection(
          inspectBody,
          reportNativeTerminal,
          turnAc.signal,
          () => unregisterTurn(turnAc),
          logCtx,
          () => options.onNativePassthroughCancel?.(),
          rememberPassthroughResponse,
          options.onFirstOutput,
        );
      } else {
        consumeForResponseLogMetadata(
          inspectBody,
          logCtx,
          turnAc.signal,
          () => unregisterTurn(turnAc),
          rememberPassthroughResponse,
          options.onFirstOutput,
        );
      }
      if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
      // win32 must keep the pure native relay (Bun#32111 JS-sink segfault); elsewhere a JS pull
      // relay is established practice (relayWithAbort, relaySseWithHeartbeat) and lets a
      // mid-stream reset end with a clean response.failed terminal instead of a raw socket error.
      // Compose opt-in payload rewrites into one parse/stringify pass (image-gen restore first).
      const payloadRewrites = [
        createImageGenCallRestoreRewrite(imageGenCallAliases),
        hasResponsesItemIdRepair(repairConfig)
          ? createResponsesItemIdPayloadRewrite(repairConfig!)
          : undefined,
      ].filter((rewrite): rewrite is NonNullable<typeof rewrite> => rewrite !== undefined);
      const rewrittenBody = payloadRewrites.length > 0
        ? relaySseWithPayloadRewrite(nativeBody, composeSsePayloadRewrites(...payloadRewrites))
        : nativeBody;
      const clientBody = process.platform === "win32" && !needsClientRewrite
        ? nativeBody
        : relaySseWithFailedTail(rewrittenBody, upstream);
      return markNativePassthroughSseResponse(new Response(clientBody, {
        status: upstreamResponse.status,
        headers,
      }));
    }
    if (headers.get("content-type")?.toLowerCase().includes("application/json")) {
      const text = await upstreamResponse.text();
      inspectResponseLogJson(logCtx, text);
      if (rememberPassthroughResponse) {
        try {
          rememberPassthroughResponse(JSON.parse(text) as { id?: unknown; output?: unknown; status?: unknown });
        } catch { /* non-JSON despite content-type; recording is best-effort */ }
      }
      return new Response(restoreImageGenCallsInJson(text, imageGenCallAliases), {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    }
    const body = relayWithAbort(upstreamResponse.body, upstream);
    const turnAc = new AbortController();
    const tracked = body ? trackStreamLifetime(body, turnAc) : null;
    return new Response(tracked, {
      status: upstreamResponse.status,
      headers,
    });
  }

  // Image / web-search sidecars: plan once, then dispatch with runTurn-aware priority.
  // Routed-compaction turns must NOT hit the image bridge: compaction clears tools/_webSearch but
  // leaves _imageGeneration, so planImageBridge would activate and return a normal Responses
  // completion instead of the synthetic compaction item Codex expects (#424).
  //
  // Web-search's loop only supports buildRequest/fetch/parseStream — NOT adapter.runTurn. Sending
  // Cursor/runTurn requests into runWithWebSearch produces empty HTTP failures. So:
  //   - non-runTurn: web-search wins over image when both eligible (documented priority)
  //   - runTurn: image bridge may run (it supports runTurn); web-search is skipped so runTurn
  //     can proceed for web-search-only turns
  const wsPlan = !routedCompaction
    ? planWebSearch(config, parsed, false, route.provider, route.modelId, openAiSidecar)
    : undefined;
  const imgPlan = !routedCompaction ? await planImageBridge(config, parsed, route.provider) : undefined;
  const vidPlan = !routedCompaction ? await planVideoBridge(config, parsed, route.provider) : undefined;
  const canRunWebSearch = !!wsPlan && !adapter.runTurn;
  if ((imgPlan || vidPlan) && canRunWebSearch) {
    // Web search takes priority when both are active — the media bridge cannot run
    // alongside runWithWebSearch. Surface a runtime signal so the user knows their
    // configured video/image bridge was skipped for this turn, rather than silently
    // dropping a paid capability.
    if (vidPlan) console.warn("[videos] video bridge skipped: web search is active for this turn");
    if (imgPlan) console.warn("[images] image bridge skipped: web search is active for this turn");
  }
  if ((imgPlan || vidPlan) && (!wsPlan || adapter.runTurn)) {
    // The image bridge detects a hosted image_generation tool and requires streaming.
    // The video bridge activates from config and injects a tool — it also needs streaming
    // (the loop returns SSE). For video-only (no imgPlan) on a non-streaming request, skip
    // the bridge entirely so enabling the feature doesn't break ordinary non-streaming traffic.
    if (!parsed.stream) {
      if (imgPlan) {
        return formatErrorResponse(400, "invalid_request_error", "image bridge requires stream=true");
      }
      // Video-only: skip bridge for non-streaming requests
    } else {
    // Replace any pre-existing image_gen/video_gen aliases instead of appending duplicate wire names.
    const priorTools = parsed.context.tools ?? [];
    const bridgeTools = [...priorTools.filter(t => {
      if (t.imageGeneration) return false;
      if (t.videoGeneration) return false;
      if (imgPlan && imgPlan.toolNames.has(t.name)) return false;
      if (imgPlan && t.namespace && imgPlan.toolNames.has(namespacedToolName(t.namespace, t.name))) return false;
      // Only strip unnamespaced video_gen aliases — a namespaced MCP video_gen is left alone.
      if (vidPlan && !t.namespace && vidPlan.toolNames.has(t.name)) return false;
      return true;
    })];
    const existingNames = new Set(bridgeTools.map(t => t.name));
    if (imgPlan && !existingNames.has(IMAGE_GEN_TOOL_NAME)) bridgeTools.push(buildImageTool());
    if (vidPlan && !existingNames.has(VIDEO_GEN_TOOL_NAME)) bridgeTools.push(buildVideoTool());
    parsed.context.tools = bridgeTools;
    // Hosted image_generation tool_choice / allowed_tools must target the synthetic function name.
    // Gate on imgPlan — in a video-only turn buildImageTool() was never injected, so rewriting
    // image_generation/image_gen aliases would add an undeclared tool that strict upstreams reject.
    const tc = parsed.options.toolChoice;
    if (imgPlan && tc && typeof tc === "object" && "allowedTools" in tc && Array.isArray(tc.allowedTools)) {
      const mapped = tc.allowedTools.map(name =>
        name === "image_generation" || name === "image_gen" || (imgPlan.toolNames.has(name) ?? false)
          ? IMAGE_GEN_TOOL_NAME
          : name,
      );
      parsed.options.toolChoice = { ...tc, allowedTools: [...new Set(mapped)] };
    } else if (imgPlan && tc && typeof tc === "object" && "name" in tc && typeof tc.name === "string"
      && (tc.name === "image_generation" || imgPlan.toolNames.has(tc.name))) {
      parsed.options.toolChoice = { ...tc, name: IMAGE_GEN_TOOL_NAME };
    }
    const imgResponse = await runWithImageBridge({
      parsed, adapter,
      ...(imgPlan ? { plan: imgPlan } : {}),
      ...(vidPlan ? { videoPlan: vidPlan } : {}),
      forwardHeaders: selectedForwardHeaders,
      onAttemptSend: () => noteAttemptSend(logCtx.activeAttempt, logCtx.usageLogInputTokens),
      abortSignal: options.abortSignal,
      maxRounds: imgPlan && vidPlan
        ? clampImageMaxRounds(Math.min(config.images?.maxRounds ?? 3, config.images?.videoMaxRounds ?? 2))
        : imgPlan
          ? clampImageMaxRounds(config.images?.maxRounds)
          : clampImageMaxRounds(config.images?.videoMaxRounds ?? 2),
      connectTimeoutMs: config.connectTimeoutMs ?? 200_000,
      stallTimeoutSec: config.stallTimeoutSec,
      fetchImpl: providerFetch(route.provider),
      onRequestBuilt: request => recordAdapterReasoning(logCtx, request),
      ...(vidPlan?.timeoutMs ? { videoTimeoutMs: vidPlan.timeoutMs } : {}),
      onUsage: usage => {
        // Cursor may assign _cursorConversationId inside the image loop's first runTurn;
        // backfill so Logs can filter/total that opening request (parity with the normal
        // runTurn branch).
        if (!logCtx.conversationId && parsed._cursorConversationId) {
          logCtx.conversationId = normalizeLogConversationId(parsed._cursorConversationId);
        }
        logCtx.usageFromBridge = true;
        if (usage) {
          logCtx.usage = usage;
          if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
        }
      },
      on429: (retryAfter, hop) => {
        // Fase C: provider-specific rate-limit signal parsed from the hop HEADERS (no body read).
        const hopRateLimit = hop?.headers
          ? rateLimitForFailure(route.providerName, hop.status ?? 429, hop.headers, activeAdapter)
          : null;
        const rotated = resolveOutcome({
          config,
          persistConfig,
          providerName: route.providerName,
          routedProvider: route.provider,
          status: hop?.status ?? 429,
          retryAfter,
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: parsed.options.promptCacheKey,
          message: hop?.message,
          rateLimit: hopRateLimit,
        });
        if (!rotated) return null;
        route.provider = rotated;
        return resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider),
          config.cacheRetention,
        );
      },
      ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
      ...(options.forceEmptyResponseId ? { forceEmptyResponseId: true } : {}),
      onCompletedResponse: (response, providerState) =>
        rememberResponseState(
          parsed._rawBody,
          response,
          continuationStateForResponse(providerState),
          adapterNeedsForcedContinuation(adapter.name) ? { force: true } : undefined,
        ),
    });
    if (imgResponse.body) {
      await persistHardCap(imgResponse);
      const imgTurnAc = new AbortController();
      return new Response(trackStreamLifetime(imgResponse.body, imgTurnAc), {
        status: imgResponse.status,
        headers: imgResponse.headers,
      });
    }
    await persistHardCap(imgResponse);
    return imgResponse;
    } // end else (streaming bridge)
  }

  // Web-search sidecar: Codex enabled web_search but this is a routed (non-OpenAI) model that can't
  // run it server-side. Expose web_search as a function tool and run searches via the gpt-mini sidecar
  // through the ChatGPT passthrough, looping until the model answers. Otherwise take the normal path.
  // Placed BEFORE the runTurn early-return for non-runTurn adapters so dual-tool turns dispatch
  // through web-search instead of being swallowed. runTurn adapters never enter this branch.
  if (canRunWebSearch && wsPlan) {
    parsed.context.tools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
    noteAttemptSend(logCtx.activeAttempt, logCtx.usageLogInputTokens);
    const wsResponse = await runWithWebSearch({
      parsed, adapter,
      backend: wsPlan.backend,
      forwardProvider: wsPlan.forwardSidecar?.provider,
      anthropicSidecar: wsPlan.anthropicSidecar,
      hostedTool: wsPlan.hostedTool,
      selectedForwardHeaders: wsPlan.forwardSidecar?.headers ?? selectedForwardHeaders,
      settings: wsPlan.settings,
      maxSearches: wsPlan.maxSearches,
      forceEmptyResponseId: true,
      abortSignal: options.abortSignal,
      ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
      onRequestBuilt: request => recordAdapterReasoning(logCtx, request),
      onUsage: usage => {
        logCtx.usageFromBridge = true;
        if (usage) {
          logCtx.usage = usage;
          if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
        }
      },
      recordSidecarOutcome: wsPlan.forwardSidecar?.recordOutcome,
      connectTimeoutMs: config.connectTimeoutMs ?? 200_000,
      routedModelStallTimeoutMs: wsPlan.routedModelStallTimeoutMs,
      stallTimeoutSec: wsPlan.stallTimeoutSec,
      on429: (retryAfter, hop) => {
        // Fase C: provider-specific rate-limit signal parsed from the hop HEADERS (no body read).
        const hopRateLimit = hop?.headers
          ? rateLimitForFailure(route.providerName, hop.status ?? 429, hop.headers, activeAdapter)
          : null;
        const rotated = resolveOutcome({
          config,
          persistConfig,
          providerName: route.providerName,
          routedProvider: route.provider,
          status: hop?.status ?? 429,
          retryAfter,
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: parsed.options.promptCacheKey,
          message: hop?.message,
          rateLimit: hopRateLimit,
        });
        if (!rotated) return null;
        route.provider = rotated;
        return resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider),
          config.cacheRetention,
        );
      },
    });
    // Register the sidecar stream as an active turn so drainAndShutdown waits for (or aborts)
    // in-flight web-search turns instead of skipping them during graceful shutdown.
    if (wsResponse.body) {
      await persistHardCap(wsResponse);
      const wsTurnAc = new AbortController();
      return new Response(trackStreamLifetime(wsResponse.body, wsTurnAc), {
        status: wsResponse.status,
        headers: wsResponse.headers,
      });
    }
    await persistHardCap(wsResponse);
    return wsResponse;
  }

  if (adapter.runTurn) {
    let activeRunTurnAdapter = adapter;
    const startRunTurnAttempt = () => {
      const runTurnAbort = new AbortController();
      const unlinkAbort = linkAbortSignal(runTurnAbort, options.abortSignal);
      const queue = createAdapterEventQueue({
        onBacklogExceeded: () => runTurnAbort.abort(),
      });
      const attemptAdapter = activeRunTurnAdapter;
      const done = (async (): Promise<void> => {
        try {
          noteAttemptSend(logCtx.activeAttempt, logCtx.usageLogInputTokens);
          await attemptAdapter.runTurn?.(
            parsed,
            {
              headers: selectedForwardHeaders,
              abortSignal: runTurnAbort.signal,
              attemptBudget: options.attemptBudget,
            },
            queue.push,
          );
        } catch (err) {
          queue.push({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          unlinkAbort();
          // Cursor assigns a stable conversation id inside runTurn on the first headerless
          // turn; backfill so Logs can filter/total that opening request (#330 / #522).
          if (!logCtx.conversationId && parsed._cursorConversationId) {
            logCtx.conversationId = normalizeLogConversationId(parsed._cursorConversationId);
          }
          queue.close();
        }
      })();
      return { runTurnAbort, queue, done };
    };
    const rotateCursorRunTurn = async (
      message: string,
      retryAfter?: string | null,
    ): Promise<boolean> => {
      if (
        !cursorPoolAccountId
        || cursorPoolFailovers >= CURSOR_POOL_MAX_FAILOVERS_PER_REQUEST
        || options.abortSignal?.aborted
      ) {
        return false;
      }
      const hop = await resolveCursorPoolOutcome({
        config,
        message,
        failedAccountId: cursorPoolAccountId,
        routedProvider: route.provider,
        retryAfter: retryAfter ?? null,
        sessionKey: cursorSessionKey,
      });
      if (!hop) return false;
      cursorPoolAccountId = hop.accountId;
      cursorPoolFailovers += 1;
      parsed._cursorIdentityScope = hop.accountId;
      route.provider = hop.provider;
      logCtx.provider = hop.logProvider;
      activeRunTurnAdapter = resolveAdapter(
        resolveWireProtocolOverride(route.providerName, route.modelId, route.provider),
        config.cacheRetention,
      );
      sealRequestAttemptIdentity(
        logCtx.activeAttempt,
        logCtx.provider,
        activeRunTurnAdapter.name,
      );
      return true;
    };
    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    if (parsed.stream) {
      let attempt = startRunTurnAttempt();
      let eventSource: AsyncIterable<AdapterEvent>;
      while (true) {
        eventSource = attempt.queue.stream();
        if (!options.comboAttempt && !cursorPoolAccountId) break;
        const preflight = await preflightAdapterEvents(eventSource);
        if (
          preflight.error
          && await rotateCursorRunTurn(preflight.error.message, preflight.error.retryAfter)
        ) {
          attempt.runTurnAbort.abort();
          attempt.queue.close();
          await attempt.done;
          attempt = startRunTurnAttempt();
          continue;
        }
        if (preflight.error || preflight.empty) {
          if (options.comboAttempt) {
            attempt.runTurnAbort.abort();
            attempt.queue.close();
            const message = preflight.error?.message ?? "Adapter ended before producing a response";
            return formatErrorResponse(502, "upstream_error", redactSecretString(message));
          }
        }
        eventSource = preflight.stream;
        break;
      }
      const sseStream = bridgeToResponsesSSE(
        eventSource, parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
        () => {
          attempt.runTurnAbort.abort();
          attempt.queue.close();
        }, 2_000,
        {
          ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
          stallTimeoutSec: config.stallTimeoutSec,
          hideThinkingSummary: parsed.options.hideThinkingSummary,
          ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
          ...(routedCompaction ? { compaction: true } : {}),
          onUsage: usage => {
            // Raw adapter usage, pre wire-normalization: the bridged SSE now always carries
            // zero-default detail objects, so provenance must come from here (cache_detail_missing).
            logCtx.usageFromBridge = true;
            if (usage) {
              logCtx.usage = usage;
              if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
            }
          },
          ...(routedCompaction ? {} : {
            onCompletedResponse: (response: Record<string, unknown>, providerState?: OcxProviderContinuationState) =>
              rememberResponseState(
                parsed._rawBody,
                response,
                continuationStateForResponse(providerState),
                adapterNeedsForcedContinuation(activeRunTurnAdapter.name) ? { force: true } : undefined,
              ),
          }),
        },
      );
      const bridgeTurnAc = new AbortController();
      const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc);
      return new Response(trackedSse, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
      });
    }

    let events: AdapterEvent[];
    while (true) {
      const attempt = startRunTurnAttempt();
      await attempt.done;
      events = await attempt.queue.collect();
      const firstMeaningful = events.find(event => event.type !== "heartbeat");
      if (
        firstMeaningful?.type === "error"
        && await rotateCursorRunTurn(firstMeaningful.message, firstMeaningful.retryAfter)
      ) {
        continue;
      }
      break;
    }
    if (options.comboAttempt) {
      const firstMeaningful = events.find(event => event.type !== "heartbeat");
      if (!firstMeaningful || firstMeaningful.type === "error") {
        const message = firstMeaningful?.type === "error"
          ? firstMeaningful.message
          : "Adapter ended before producing a response";
        return formatErrorResponse(502, "upstream_error", redactSecretString(message));
      }
    }
    let providerState: OcxProviderContinuationState | undefined;
    const json = buildResponseJSON(events, parsed.modelId, {
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      freeformToolNames,
      toolSearchToolNames,
      ...(routedCompaction ? { compaction: true } : {}),
      onProviderState: state => { providerState = state; },
      onUsage: usage => {
        logCtx.usageFromBridge = true;
        if (usage) {
          logCtx.usage = usage;
          if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
        }
      },
    });
    if (!routedCompaction) {
      rememberResponseState(
        parsed._rawBody,
        json,
        continuationStateForResponse(providerState),
        adapterNeedsForcedContinuation(activeRunTurnAdapter.name) ? { force: true } : undefined,
      );
    }
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  const upstream = new AbortController();
  const cleanupUpstreamAbort = linkAbortSignal(upstream, options.abortSignal);
  const connectMs = config.connectTimeoutMs ?? 200_000;
  let activeAdapter = adapter;

  let request;
  try {
    request = await activeAdapter.buildRequest(parsed, { headers: selectedForwardHeaders });
  } catch (err) {
    cleanupUpstreamAbort();
    return resolveAdapterBuildRequestError(err, options.abortSignal);
  }
  recordAdapterReasoning(logCtx, request);
  const inputTokenEstimate = typeof request.usageLog?.inputTokens === "number"
    ? request.usageLog.inputTokens
    : undefined;
  if (inputTokenEstimate !== undefined) logCtx.usageLogInputTokens = inputTokenEstimate;
  let upstreamResponse: Response;
  try {
    if (activeAdapter.fetchResponse) {
      if (
        !adapterOwnsAttemptBudget(activeAdapter.name)
        && options.attemptBudget
        && !options.attemptBudget.tryBegin()
      ) {
        return formatErrorResponse(
          502,
          "upstream_error",
          "OCX upstream attempt budget exhausted",
        );
      }
      noteAttemptSend(logCtx.activeAttempt, inputTokenEstimate);
      upstreamResponse = await activeAdapter.fetchResponse(request, {
        abortSignal: upstream.signal,
        timeoutMs: connectMs,
        skip429Retry: antigravityPoolOwns429,
        stream: parsed.stream,
        ...(adapterOwnsAttemptBudget(activeAdapter.name)
          ? { attemptBudget: options.attemptBudget }
          : {}),
      });
    } else {
      upstreamResponse = await fetchWithResetRetry(
        recovery => {
          noteAttemptSend(logCtx.activeAttempt, inputTokenEstimate, recovery);
          return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
            method: request.method,
            headers: request.headers,
            body: request.body,
          }, recovery), upstream.signal, connectMs, parsed.stream, providerFetch(route.provider));
        },
        {
          abortSignal: upstream.signal,
          label: safeHostLabel(request.url),
          attemptBudget: options.attemptBudget,
        },
      );
    }
  } catch (err) {
    cleanupUpstreamAbort();
    upstream.abort();
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    const msg = describeUpstreamConnectFailure(err, connectMs);
    return formatErrorResponse(502, "upstream_error", msg);
  }

  if (!upstreamResponse.ok) {
    // Recovery loop: multi-key 429 failover + at most ONE anthropic 413 tightened retry
    // (devlog/260714_image_normalization_pipeline/030). One mutable activeAdapter serves
    // both paths so a 429→413 sequence never rebuilds against a stale pre-rotation
    // adapter, and imageTierBias — once armed — rides EVERY subsequent rebuild so a
    // 413→429 rotation cannot silently undo the tightening.
    let imageTierBias = 0;
    let imageRetryAttempted = false;
    let oauth401ReplayAttempted = false;
    const rebuildAndRefetch = async (
      recovery: AttemptRecoveryKind,
    ): Promise<Response | { failed: Response }> => {
      let retryRequest;
      try {
        retryRequest = await activeAdapter.buildRequest(parsed, {
          headers: selectedForwardHeaders,
          ...(imageTierBias > 0 ? { imageTierBias } : {}),
        });
      } catch (err) {
        cleanupUpstreamAbort();
        return { failed: resolveAdapterBuildRequestError(err, options.abortSignal) };
      }
      recordAdapterReasoning(logCtx, retryRequest);
      const retryEstimate = typeof retryRequest.usageLog?.inputTokens === "number"
        ? retryRequest.usageLog.inputTokens
        : undefined;
      if (retryEstimate !== undefined) logCtx.usageLogInputTokens = retryEstimate;
      logCtx.providerAdapter = activeAdapter.name;
      sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, activeAdapter.name);
      noteAttemptSend(logCtx.activeAttempt, retryEstimate, recovery);
      try {
        if (activeAdapter.fetchResponse) {
          if (
            !adapterOwnsAttemptBudget(activeAdapter.name)
            && options.attemptBudget
            && !options.attemptBudget.tryBegin()
          ) {
            return {
              failed: formatErrorResponse(
                502,
                "upstream_error",
                "OCX upstream attempt budget exhausted",
              ),
            };
          }
          return await activeAdapter.fetchResponse(retryRequest, {
            abortSignal: upstream.signal,
            timeoutMs: connectMs,
            skip429Retry: antigravityPoolOwns429,
            stream: parsed.stream,
            ...(adapterOwnsAttemptBudget(activeAdapter.name)
              ? { attemptBudget: options.attemptBudget }
              : {}),
          });
        }
        if (options.attemptBudget && !options.attemptBudget.tryBegin()) {
          return {
            failed: formatErrorResponse(
              502,
              "upstream_error",
              "OCX upstream attempt budget exhausted",
            ),
          };
        }
        return await fetchWithHeaderTimeout(retryRequest.url, {
          method: retryRequest.method, headers: retryRequest.headers, body: retryRequest.body,
        }, upstream.signal, connectMs, parsed.stream, providerFetch(route.provider));
      } catch (err) {
        cleanupUpstreamAbort();
        upstream.abort();
        if (options.abortSignal?.aborted) {
          return { failed: clientCancelledResponse() };
        }
        const msg = describeUpstreamConnectFailure(err, connectMs);
        return { failed: formatErrorResponse(502, "upstream_error", msg) };
      }
    };
    const canRotateOrCoolFailure = async (response: Response): Promise<boolean> => {
      if ((options.attemptBudget?.remaining ?? 0) === 0) return false;
      return upstreamAllowsRotateOrCool(activeAdapter.name, response, options.abortSignal);
    };
    recovery: for (;;) {
      if (
        upstreamResponse.status === 401
        && isOAuth401ReplayProvider
        && sentOAuthSnapshot
        && !oauth401ReplayAttempted
        && (options.attemptBudget?.remaining ?? 1) > 0
      ) {
        oauth401ReplayAttempted = true;
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        let refreshed: OAuthAccessSnapshot;
        try {
          refreshed = await forceRefreshOAuthAccessSnapshot(sentOAuthSnapshot);
        } catch (err) {
          cleanupUpstreamAbort();
          return formatErrorResponse(401, "authentication_error", err instanceof Error ? err.message : String(err));
        }
        sentOAuthSnapshot = refreshed;
        if (route.providerName === "kiro") {
          parsed._kiroAuthContext = { ...(refreshed.kiro ?? {}) };
        }
        const refreshedProvider = resolveProviderTransport(
          route.providerName,
          { ...route.provider, apiKey: refreshed.accessToken },
          parsed.options.promptCacheKey,
          route.providerName === "github-copilot" ? getOAuthCredentialApiBaseUrl(route.providerName) : undefined,
        );
        route.provider = refreshedProvider;
        activeAdapter = resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, refreshedProvider),
          config.cacheRetention,
        );
        const result = await rebuildAndRefetch("oauth-401");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
        continue recovery;
      }

      // Multi-key 429/529 hop: Availability records the failed key and returns the next
      // fetch-ready provider, or null to surface. OAuth/forward and single-key pools no-op.
      while (
        isAccountPoolHopStatus(upstreamResponse.status)
        && keyPoolCanHop(route.provider)
        && await canRotateOrCoolFailure(upstreamResponse)
      ) {
        const hopMessage = await peekUpstreamErrorText(upstreamResponse, options.abortSignal);
        // Fase C: read the provider-specific rate-limit signal (anthropic-ratelimit-*, OpenAI
        // x-ratelimit-*, spend-cap vs window exhaustion) so the cooldown math uses the real
        // upstream signal instead of a generic 429 default.
        const hopRateLimit = rateLimitForFailure(
          route.providerName,
          upstreamResponse.status,
          upstreamResponse.headers,
          activeAdapter,
        );
        const rotated = resolveOutcome({
          config,
          persistConfig,
          providerName: route.providerName,
          routedProvider: route.provider,
          status: upstreamResponse.status,
          retryAfter: upstreamResponse.headers.get("retry-after"),
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: parsed.options.promptCacheKey,
          message: hopMessage,
          rateLimit: hopRateLimit,
        });
        if (!rotated) break;
        // Release the failed response's socket before retrying; unread bodies otherwise linger
        // until runtime cleanup (one per rotated key under a rate-limit storm).
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        route.provider = rotated;
        activeAdapter = resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider),
          config.cacheRetention,
        );
        const result = await rebuildAndRefetch("key-429");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
      }

      // Opt-in Anthropic OAuth account pool (#294): cool the failed account and retry
      // with another eligible OAuth account (bounded per request). Disabled by default.
      while (
        isAccountPoolHopStatus(upstreamResponse.status)
        && anthropicPoolAccountId
        && isAnthropicAccountPoolEnabled(config)
        && anthropicPoolFailovers < ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST
        && await canRotateOrCoolFailure(upstreamResponse)
      ) {
        const hop = await resolveAnthropicPoolOutcome({
          config,
          status: upstreamResponse.status,
          failedAccountId: anthropicPoolAccountId,
          routedProvider: route.provider,
          retryAfter: upstreamResponse.headers.get("retry-after"),
          sessionKey: anthropicSessionKey,
        });
        if (!hop) break;
        try {
          const nextAdapter = resolveAdapter(
            resolveWireProtocolOverride(route.providerName, route.modelId, hop.provider),
            config.cacheRetention,
          );
          sealRequestAttemptIdentity(logCtx.activeAttempt, hop.logProvider, nextAdapter.name);
          anthropicPoolAccountId = hop.accountId;
          anthropicPoolFailovers += 1;
          route.provider = hop.provider;
          logCtx.provider = hop.logProvider;
          activeAdapter = nextAdapter;
        } catch {
          break;
        }
        // Cancel only after a next account is bound. Cancelling first drops the
        // 429 body, and the surface path then reports "unknown error".
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        const result = await rebuildAndRefetch("anthropic-oauth-429");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
      }
      // Opt-in Google Antigravity OAuth pool: rotate on 429 and native 529
      // overload. Transport failures, client aborts, and 4xx never enter this
      // block. Keep the shared Antigravity session id so replay state survives.
      while (
        isAccountPoolHopStatus(upstreamResponse.status)
        && googleAntigravityPoolAccountId
        && isGoogleAntigravityAccountPoolEnabled(config)
        && googleAntigravityPoolFailovers
          < GOOGLE_ANTIGRAVITY_POOL_MAX_FAILOVERS_PER_REQUEST
        && await canRotateOrCoolFailure(upstreamResponse)
      ) {
        const hop = await resolveGoogleAntigravityPoolOutcome({
          config,
          status: upstreamResponse.status,
          failedAccountId: googleAntigravityPoolAccountId,
          routedProvider: route.provider,
          retryAfter: upstreamResponse.headers.get("retry-after"),
          sessionKey: antigravitySessionKey,
        });
        if (!hop) break;
        try {
          const nextAdapter = resolveAdapter(
            resolveWireProtocolOverride(
              route.providerName,
              route.modelId,
              hop.provider,
            ),
            config.cacheRetention,
          );
          sealRequestAttemptIdentity(
            logCtx.activeAttempt,
            hop.logProvider,
            nextAdapter.name,
          );
          googleAntigravityPoolAccountId = hop.accountId;
          googleAntigravityPoolFailovers += 1;
          route.provider = hop.provider;
          logCtx.provider = hop.logProvider;
          activeAdapter = nextAdapter;
        } catch {
          break;
        }
        try {
          void upstreamResponse.body?.cancel().catch(() => {});
        } catch {
          /* already consumed/closed */
        }
        const result = await rebuildAndRefetch("google-antigravity-oauth-429");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
      }
      // Anthropic 413 request_too_large: rebuild once with every image one tier lower
      // (spiral guard: single attempt). The biased response re-enters the 429 check above.
      if (shouldAttemptImageTierRetry({
        status: upstreamResponse.status,
        adapterName: activeAdapter.name,
        parsed,
        alreadyAttempted: imageRetryAttempted,
      })) {
        imageRetryAttempted = true;
        imageTierBias = 1;
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        const result = await rebuildAndRefetch("image-413");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
        continue recovery;
      }
      break;
    }
    if (!upstreamResponse.ok) {
      if (options.comboAttempt) {
        const failure = await consumeComboFailure(upstreamResponse, options.abortSignal)
          .finally(cleanupUpstreamAbort);
        recordCapOutcome({
          config,
          persistConfig,
          providerName: route.providerName,
          status: failure.response.status,
          message: failure.classificationText,
        });
        options.onConsumedComboFailure?.(failure);
        return failure.response;
      }
      const errorText = await upstreamResponse.text().catch(() => "unknown error");
      recordCapOutcome({
        config,
        persistConfig,
        providerName: route.providerName,
        status: upstreamResponse.status,
        message: errorText,
      });
      cleanupUpstreamAbort();
      recordSubagentQuotaFailureForThreadSpawn(
        req.headers,
        subagentQuotaFailureModel,
        upstreamResponse.status === 429 || upstreamResponse.status === 402
          ? upstreamResponse.status
          : `Provider error ${upstreamResponse.status}: ${redactSecretString(errorText.slice(0, 500))}`,
        config,
        subagentFallbackAccountId,
      );
      // Upstreams occasionally echo request details in error bodies — scrub token-shaped
      // material before it reaches the client-facing error surface.
      const message = `Provider error ${upstreamResponse.status}: ${redactSecretString(errorText.slice(0, 500))}`;
      const retryAfter = resolveClientRetryAfter({
        status: upstreamResponse.status,
        message,
        upstreamRetryAfter: upstreamResponse.headers.get("retry-after"),
      });
      return formatErrorResponse(upstreamResponse.status, "upstream_error", message, {
        ...(retryAfter !== undefined ? { retryAfter } : {}),
      });
    }
  }

  cancelBodyOnAbort(upstreamResponse.body, upstream.signal);

  // Claude can return a clean end_turn after announcing an edit without emitting any tool call.
  // Keep the normal request/recovery path above intact, and use this bounded callback only for the
  // one internal continuation pass. A continuation failure becomes an in-stream adapter error so
  // the client never sees a second hidden HTTP response or an unbounded retry loop.
  // A per-provider fallback hop is a plain request wearing a combo's clothes, so it keeps the
  // guard; a user-configured combo target does not (the parent hop loop owns that turn).
  const terminalGuardEnabled = activeAdapter.name === "anthropic"
    && (!options.comboAttempt || options.providerFallbackAttempt === true)
    && !routedCompaction;
  const fetchTerminalGuardContinuation = async function* (nextParsed: OcxParsedRequest): AsyncGenerator<AdapterEvent> {
    let imageTierBias = 0;
    let response: Response | undefined;
    while (true) {
      let continuationRequest;
      try {
        continuationRequest = await activeAdapter.buildRequest(nextParsed, {
          headers: selectedForwardHeaders,
          ...(imageTierBias > 0 ? { imageTierBias } : {}),
        });
      } catch (error) {
        const classified = classifyAdapterBuildRequestError(error, options.abortSignal);
        yield {
          type: "error",
          message: classified.message,
          status: classified.status,
        };
        return;
      }
      recordAdapterReasoning(logCtx, continuationRequest);
      const continuationEstimate = typeof continuationRequest.usageLog?.inputTokens === "number"
        ? continuationRequest.usageLog.inputTokens
        : undefined;
      if (continuationEstimate !== undefined) logCtx.usageLogInputTokens = continuationEstimate;
      try {
        if (activeAdapter.fetchResponse) {
          noteAttemptSend(logCtx.activeAttempt, continuationEstimate);
          response = await activeAdapter.fetchResponse(continuationRequest, {
              abortSignal: upstream.signal,
              timeoutMs: connectMs,
              skip429Retry: antigravityPoolOwns429,
              stream: nextParsed.stream,
            });
        } else {
          response = await fetchWithResetRetry(
              recovery => {
                noteAttemptSend(logCtx.activeAttempt, continuationEstimate, recovery);
                return fetchWithHeaderTimeout(
                  continuationRequest.url,
                  applyUpstreamRecoveryInit({
                    method: continuationRequest.method,
                    headers: continuationRequest.headers,
                    body: continuationRequest.body,
                  }, recovery),
                  upstream.signal,
                  connectMs,
                  nextParsed.stream,
                  providerFetch(route.provider),
                );
              },
              { abortSignal: upstream.signal, label: safeHostLabel(continuationRequest.url) },
            );
        }
      } catch (error) {
        if (options.abortSignal?.aborted) {
          yield { type: "error", message: "client closed request during terminal continuation", status: 499 };
        } else {
          yield { type: "error", message: `Provider continuation failed: ${error instanceof Error ? error.message : String(error)}` };
        }
        return;
      }

      {
        // Peeking clones the body (up to the bounded-read stall). Success/5xx
        // continuations never hop or record a cap, so skip the clone and the
        // resolveOutcome call. 402 still cools the attempted key without hopping.
        const needsPoolOutcome = isAccountPoolHopStatus(response.status) || response.status === 402;
        const hopMessage = needsPoolOutcome
          ? await peekUpstreamErrorText(response, options.abortSignal)
          : undefined;
        if (needsPoolOutcome) {
          const rotated = resolveOutcome({
            config,
            persistConfig,
            providerName: route.providerName,
            routedProvider: route.provider,
            status: response.status,
            retryAfter: response.headers.get("retry-after"),
            now: Date.now(),
            attemptedKey: route.provider.apiKey,
            promptCacheKey: nextParsed.options.promptCacheKey,
            message: hopMessage,
          });
          if (rotated) {
            try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
            route.provider = rotated;
            activeAdapter = resolveAdapter(
              resolveWireProtocolOverride(route.providerName, route.modelId, route.provider),
              config.cacheRetention,
            );
            continue;
          }
        }
      }
      if (
        isAccountPoolHopStatus(response.status)
        && anthropicPoolAccountId
        && isAnthropicAccountPoolEnabled(config)
        && anthropicPoolFailovers < ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST
        && await upstreamAllowsRotateOrCool(activeAdapter.name, response, options.abortSignal)
      ) {
        const hop = await resolveAnthropicPoolOutcome({
          config,
          status: response.status,
          failedAccountId: anthropicPoolAccountId,
          routedProvider: route.provider,
          retryAfter: response.headers.get("retry-after"),
          sessionKey: anthropicSessionKey,
        });
        if (hop) {
          try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
          anthropicPoolAccountId = hop.accountId;
          anthropicPoolFailovers += 1;
          route.provider = hop.provider;
          logCtx.provider = hop.logProvider;
          activeAdapter = resolveAdapter(
            resolveWireProtocolOverride(route.providerName, route.modelId, route.provider),
            config.cacheRetention,
          );
          sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, activeAdapter.name);
          continue;
        }
      }
      if (shouldAttemptImageTierRetry({
        status: response.status,
        adapterName: activeAdapter.name,
        parsed: nextParsed,
        alreadyAttempted: imageTierBias > 0,
      })) {
        imageTierBias = 1;
        try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
        continue;
      }
      break;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      yield {
        type: "error",
        status: response.status,
        message: `Provider continuation error ${response.status}: ${redactSecretString(errorText.slice(0, 500))}`,
      };
      return;
    }

    try {
      // Protect the continuation body against a client abort landing between fetch resolution and
      // reader attach, exactly as the initial response is guarded above (#390/366e3053). Without
      // this, a client cancel during the continuation reopens the Bun fetch-to-reader abort race.
      const detachContinuationBodyGuard = cancelBodyOnAbort(response.body, upstream.signal);
      try {
        if (nextParsed.stream) {
          yield* activeAdapter.parseStream(response);
        } else if (activeAdapter.parseResponse) {
          yield* await activeAdapter.parseResponse(response);
        } else {
          yield { type: "error", message: "Provider continuation does not support response parsing" };
        }
      } finally {
        detachContinuationBodyGuard();
      }
    } catch (error) {
      if (options.abortSignal?.aborted) {
        yield { type: "error", message: "client closed request during terminal continuation", status: 499 };
      } else {
        yield { type: "error", message: `Provider continuation parse failed: ${redactSecretString(error instanceof Error ? error.message : String(error))}` };
      }
    }
  };

  if (parsed.stream) {
    const initialEventStream = activeAdapter.parseStream(upstreamResponse);
    const eventStream = terminalGuardEnabled
      ? guardTerminalEventStream({
          parsed,
          firstEvents: initialEventStream,
          adapterName: activeAdapter.name,
          maxAutoContinuations: 1,
          continuation: fetchTerminalGuardContinuation,
        })
      : initialEventStream;
    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    const sseStream = bridgeToResponsesSSE(
      eventStream, parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
      () => upstream.abort(), 2_000,
      {
        ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
        stallTimeoutSec: config.stallTimeoutSec,
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
        ...(routedCompaction ? { compaction: true } : {}),
        onUsage: usage => {
          // Raw adapter usage, pre wire-normalization (see the runTurn branch above).
          logCtx.usageFromBridge = true;
          if (usage) {
            logCtx.usage = usage;
            if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
          }
        },
        // Compaction turns must NOT enter the continuation cache: _rawBody still holds the full
        // PRE-compaction history, and a later previous_response_id expansion would rehydrate the
        // giant stale chain Codex just replaced.
        ...(routedCompaction ? {} : {
          onCompletedResponse: (response: Record<string, unknown>, providerState?: OcxProviderContinuationState) =>
            rememberResponseState(
              parsed._rawBody,
              response,
              continuationStateForResponse(providerState),
              activeAdapter.name === "kiro" ? { force: true } : undefined,
            ),
        }),
      },
    );
    const bridgeTurnAc = new AbortController();
    const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc, cleanupUpstreamAbort);
    return new Response(trackedSse, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
    });
  }

  if (activeAdapter.parseResponse) {
    let events: AdapterEvent[];
    try {
      const initialEvents = await activeAdapter.parseResponse(upstreamResponse);
      if (terminalGuardEnabled) {
        events = [];
        for await (const event of guardTerminalEventStream({
          parsed,
          firstEvents: (async function* () { yield* initialEvents; })(),
          adapterName: activeAdapter.name,
          maxAutoContinuations: 1,
          continuation: fetchTerminalGuardContinuation,
        })) events.push(event);
      } else {
        events = initialEvents;
      }
    } finally {
      cleanupUpstreamAbort();
    }
    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    let providerState: OcxProviderContinuationState | undefined;
    const json = buildResponseJSON(events, parsed.modelId, {
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      freeformToolNames,
      toolSearchToolNames,
      ...(routedCompaction ? { compaction: true } : {}),
      onProviderState: state => { providerState = state; },
      onUsage: usage => {
        logCtx.usageFromBridge = true;
        if (usage) {
          logCtx.usage = usage;
          if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
        }
      },
    });
    // See the streaming branch: compaction turns skip the continuation cache.
    if (!routedCompaction) {
      rememberResponseState(
        parsed._rawBody,
        json,
        continuationStateForResponse(providerState),
        activeAdapter.name === "kiro" ? { force: true } : undefined,
      );
    }
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  return formatErrorResponse(400, "invalid_request_error", "Non-streaming not supported by this adapter");
}



export function linkAbortSignal(upstream: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    upstream.abort(signal.reason);
    return () => {};
  }
  const onAbort = () => upstream.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
