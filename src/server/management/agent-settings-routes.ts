import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogModel } from "../../codex/catalog";
import {
  catalogModelSlug,
  invalidateCodexModelsCache,
  nativeModelRows,
  uniqueCatalogModelsForPublicList,
} from "../../codex/catalog";
import {
  DEFAULT_SUBAGENT_MODELS,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  multiAgentGuidanceEnabled,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  saveConfigPreservingClaudeCode,
  subagentDefaultSyncEffective,
} from "../../config";
import {
  clearLoginState,
  getLoginStatus,
  isPublicOAuthProvider,
  listOAuthProviders,
  startLoginFlow,
  submitManualLoginCode,
  upsertOAuthProvider,
} from "../../oauth";
import { removeCredential } from "../../oauth/store";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import {
  enrichProviderFromCatalog,
  listKeyLoginProviders,
} from "../../oauth/key-providers";
import { deriveProviderPresets } from "../../providers/derive";
import { providerCodexAccountMode } from "../../providers/registry";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import {
  clearProviderQuotaCache,
  fetchProviderQuotaReports,
} from "../../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import {
  DEFAULT_PROVIDER_CONTEXT_CAP,
  globalContextCapValue,
  providerContextCap,
  providerContextCaps,
  setAllProviderContextCaps,
  setGlobalContextCapValue,
  setProviderContextCap,
} from "../../providers/context-cap";
import { resolveCodexHomeDir } from "../../codex/home";
import { readUsageEntries } from "../../usage/log";
import { getUsageDebugLogEntries } from "../../usage/debug";
import {
  parseRange,
  parseUsageSurface,
  summarizeUsage,
} from "../../usage/summary";
import { stripCodexRuntimeProviderFields } from "../../codex/auth-context";
import { getProviderRegistryEntry } from "../../providers/registry";
import { getDebugLogEntries } from "../../lib/debug-log-buffer";
import { getInjectionDebugLogEntries } from "../../lib/injection-debug-log";
import {
  clearDebugSettings,
  clearDebugSetting,
  getDebugSettings,
  setDebugSettings,
  type DebugFlag,
} from "../../lib/debug-settings";
import type {
  OcxConfig,
  OcxCustomModel,
  OcxProviderConfig,
} from "../../types";
import { drainAndShutdown } from "../lifecycle";
import {
  filterRequestLogs,
  getRequestLogEntries,
  type RequestLogEntry,
} from "../request-log";
import {
  estimateComboCost,
  estimateRequestCost,
  normalizeCostTokens,
  tokensPerSecond,
} from "../../usage/cost";
import type { PersistedUsageAttempt } from "../../usage/log";
import {
  isAllowedRequestOrigin,
  jsonResponse,
  providerManagementConfigError,
  publicProviderBaseUrl,
  safeConfigDTO,
} from "../auth-cors";

import {
  isPlainRecord,
  parseDebugLogQuery,
  tokPerSecondResult,
  unavailableCostReason,
  costResult,
  requestLogDto,
  stripRegistryOnlyStaticHeaders,
  fetchAllModels,
} from "./shared";
import type {
  MetricUnavailableReason,
  TokPerSecondResult,
  CostEstimateReason,
  CostResult,
  MetricSource,
} from "./shared";

import { handleGrokRoutes } from "./grok-routes";
import { handleClaudeDesktopRoutes } from "./claude-desktop-routes";
import { handleClaudeCodeRoutes } from "./claude-code-routes";
import type { ManagementContext } from "./context";

export async function handleAgentSettingsRoutes(
  ctx: ManagementContext,
): Promise<Response | null> {
  const {
    req,
    url,
    config,
    deps,
    refreshCodexCatalogBestEffort,
    syncClaudeAgentDefsBestEffort,
  } = ctx;

  /** Best-effort Desktop 3P config auto-reconcile when providers change. */
  async function autoApplyDesktopBestEffort(): Promise<void> {
    try {
      if (config.claudeCode?.desktopAutoApply === false) return;
      if (!config.claudeCode?.desktopProfile) return;
      const { writeDesktop3pConfig } = await import("../../claude/desktop-3p");
      const { visibleNativeSlugs, filterCatalogVisibleModels } =
        await import("../../codex/catalog");
      const allModels = await fetchAllModels(config);
      const routed = filterCatalogVisibleModels(allModels, config).map((m) => ({
        provider: m.provider,
        id: m.id,
        contextWindow: m.contextWindow,
      }));
      const result = writeDesktop3pConfig(
        config.port ?? 10100,
        [...visibleNativeSlugs(config)],
        routed,
        config.apiKeys?.[0]?.key,
        "static",
        config.claudeCode.desktopProfile,
      );
      if (result.written && result.fingerprint) {
        config.claudeCode = {
          ...config.claudeCode,
          desktopProfile: {
            ...config.claudeCode.desktopProfile,
            appliedFingerprint: result.fingerprint,
            appliedAt: new Date().toISOString(),
          },
        };
        saveConfigPreservingClaudeCode(config);
      }
    } catch {
      /* best-effort */
    }
  }

  // multi_agent_v2 surface toggle. GET reports the flag + the agents.max_threads
  // boot conflict; PUT flips it via the official `codex features` CLI and RESYNCS
  // the catalog so multi-agent surface metadata stays fresh. The catalog build
  // itself never writes config — this endpoint is the only server-side mutation
  // surface for the flag.
  if (url.pathname === "/api/v2" && req.method === "GET") {
    const { isMultiAgentV2Enabled, hasAgentsMaxThreads, getLogicalMaxThreads } =
      await import("../../codex/features");
    const enabled = isMultiAgentV2Enabled();
    return jsonResponse({
      enabled,
      agentsMaxThreadsConflict: enabled && hasAgentsMaxThreads(),
      maxConcurrentThreadsPerSession: getLogicalMaxThreads(),
      multiAgentMode: config.multiAgentMode ?? "default",
    });
  }
  if (url.pathname === "/api/v2" && req.method === "PUT") {
    let body: {
      enabled?: unknown;
      maxConcurrentThreadsPerSession?: unknown;
      multiAgentMode?: unknown;
    };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    const wantsFlag = body.enabled !== undefined;
    const wantsThreads = body.maxConcurrentThreadsPerSession !== undefined;
    const wantsMode = body.multiAgentMode !== undefined;
    if (!wantsFlag && !wantsThreads && !wantsMode)
      return jsonResponse(
        {
          error:
            "body must set enabled, multiAgentMode, and/or maxConcurrentThreadsPerSession",
        },
        400,
      );
    if (wantsFlag && typeof body.enabled !== "boolean")
      return jsonResponse({ error: "body.enabled must be a boolean" }, 400);
    if (
      wantsMode &&
      body.multiAgentMode !== "v1" &&
      body.multiAgentMode !== "default" &&
      body.multiAgentMode !== "v2"
    ) {
      return jsonResponse(
        { error: "body.multiAgentMode must be 'v1', 'default', or 'v2'" },
        400,
      );
    }
    if (
      wantsThreads &&
      (typeof body.maxConcurrentThreadsPerSession !== "number" ||
        !Number.isInteger(body.maxConcurrentThreadsPerSession) ||
        body.maxConcurrentThreadsPerSession < 1)
    ) {
      return jsonResponse(
        {
          error: "body.maxConcurrentThreadsPerSession must be an integer >= 1",
        },
        400,
      );
    }
    const mode = wantsMode
      ? (body.multiAgentMode as "v1" | "default" | "v2")
      : undefined;
    const modeFlag = mode === "v2" ? true : mode === "v1" ? false : undefined;
    if (wantsFlag && modeFlag !== undefined && body.enabled !== modeFlag) {
      return jsonResponse(
        { error: `body.enabled conflicts with multiAgentMode '${mode}'` },
        400,
      );
    }
    const {
      isMultiAgentV2Enabled,
      hasAgentsMaxThreads,
      getLogicalMaxThreads,
      transitionMultiAgentV2,
    } = await import("../../codex/features");
    const warnings: string[] = [];
    const requestedFlag = wantsFlag ? (body.enabled as boolean) : modeFlag;
    if (requestedFlag !== undefined || wantsThreads) {
      const targetFlag = requestedFlag ?? isMultiAgentV2Enabled();
      let toggle = deps.toggleCodexMultiAgentV2;
      if (!toggle) {
        const { execFileSync } = await import("node:child_process");
        const { codexFeaturesInvocation } = await import("../../cli/v2");
        toggle = (enabled: boolean) => {
          const inv = codexFeaturesInvocation(enabled ? "enable" : "disable");
          execFileSync(inv.file, inv.args, {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 15_000,
            windowsHide: true,
            ...inv.options,
          });
        };
      }
      const result = transitionMultiAgentV2(targetFlag, toggle, {
        ...(wantsThreads
          ? { threadLimit: body.maxConcurrentThreadsPerSession as number }
          : {}),
      });
      if (!result.ok)
        return jsonResponse(
          { error: `multi_agent_v2 transition failed: ${result.error}` },
          502,
        );
      if (result.changed && result.threadLimit !== null)
        warnings.push(
          `Thread limit ${result.threadLimit} preserved for ${targetFlag ? "v2" : "v1"}.`,
        );
    }
    if (wantsMode) {
      if (mode === "default") delete config.multiAgentMode;
      else config.multiAgentMode = mode;
      saveConfigPreservingClaudeCode(config);
      warnings.push(
        `Multi-agent mode set to '${mode}'. Applies to new sessions.`,
      );
    }
    await refreshCodexCatalogBestEffort();
    if (requestedFlag !== undefined)
      warnings.push(
        "Applies to new sessions; restart the Codex app or wait out its picker cache to see the ladder change.",
      );
    const enabled = isMultiAgentV2Enabled();
    return jsonResponse({
      ok: true,
      enabled,
      agentsMaxThreadsConflict: enabled && hasAgentsMaxThreads(),
      maxConcurrentThreadsPerSession: getLogicalMaxThreads(),
      multiAgentMode: config.multiAgentMode ?? "default",
      warnings,
    });
  }

  // Subagent prompt injection model: single native or routed model whose info is
  // dynamically injected into the v1 proactive prompt, plus an optional reasoning
  // effort the prompt tells the agent to pass to spawn_agent. GET returns the current
  // picks + available models/efforts; PUT sets or clears them.
  if (url.pathname === "/api/injection-model" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    const { listCatalogNativeSlugs } = await import("../../codex/catalog");
    const { CODEX_REASONING_LEVELS } = await import("../../reasoning-effort");
    const nativeModels = listCatalogNativeSlugs()
      .filter((slug) => !disabled.has(slug))
      .map((slug) => ({ provider: "openai", model: slug, namespaced: slug }));
    const routedModels = uniqueCatalogModelsForPublicList(models)
      .map((m) => ({
        provider: m.provider,
        model: m.id,
        namespaced: catalogModelSlug(m),
      }))
      .filter(
        (m) =>
          ![...disabled].some(
            (stored) =>
              stored === m.namespaced ||
              slugEquals(stored, m.provider, m.model),
          ),
      );
    return jsonResponse({
      multiAgentGuidanceEnabled: multiAgentGuidanceEnabled(config),
      syncCodexSubagentDefaults: subagentDefaultSyncEffective(config),
      model: config.injectionModel ?? null,
      effort: config.injectionEffort ?? null,
      prompt: config.injectionPrompt ?? null,
      efforts: CODEX_REASONING_LEVELS.map((l) => l.effort),
      available: [...nativeModels, ...routedModels],
    });
  }
  if (url.pathname === "/api/injection-model" && req.method === "PUT") {
    let parsedBody: unknown;
    try {
      parsedBody = await req.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (
      !parsedBody ||
      typeof parsedBody !== "object" ||
      Array.isArray(parsedBody)
    ) {
      return jsonResponse({ error: "body must be a JSON object" }, 400);
    }
    const body = parsedBody as {
      multiAgentGuidanceEnabled?: unknown;
      syncCodexSubagentDefaults?: unknown;
      model?: unknown;
      effort?: unknown;
      prompt?: unknown;
    };
    const { isCodexReasoningEffort } = await import("../../reasoning-effort");

    let nextEnabled = config.multiAgentGuidanceEnabled;
    // Start from the effective state reported by GET. A stale hand-edited
    // `true` without a model must not spring back on during a model-only PUT.
    let nextSyncCodexSubagentDefaults = subagentDefaultSyncEffective(config);
    let nextModel = config.injectionModel;
    let nextEffort = config.injectionEffort;
    let nextPrompt = config.injectionPrompt;

    if ("multiAgentGuidanceEnabled" in body) {
      if (typeof body.multiAgentGuidanceEnabled !== "boolean") {
        return jsonResponse(
          { error: "multiAgentGuidanceEnabled must be a boolean" },
          400,
        );
      }
      nextEnabled = body.multiAgentGuidanceEnabled;
    }
    if ("syncCodexSubagentDefaults" in body) {
      if (typeof body.syncCodexSubagentDefaults !== "boolean") {
        return jsonResponse(
          { error: "syncCodexSubagentDefaults must be a boolean" },
          400,
        );
      }
      nextSyncCodexSubagentDefaults = body.syncCodexSubagentDefaults;
    }
    if ("model" in body) {
      if (body.model === null || body.model === "") nextModel = undefined;
      else if (typeof body.model === "string" && body.model.trim().length > 0)
        nextModel = body.model;
      else
        return jsonResponse(
          { error: "model must be a nonblank string or null" },
          400,
        );
    }
    if ("effort" in body) {
      if (body.effort === null || body.effort === "") nextEffort = undefined;
      else if (
        typeof body.effort === "string" &&
        isCodexReasoningEffort(body.effort)
      ) {
        nextEffort = body.effort;
      } else {
        return jsonResponse(
          { error: `unknown reasoning effort "${String(body.effort)}"` },
          400,
        );
      }
    }
    if ("prompt" in body) {
      if (typeof body.prompt === "string" && body.prompt.trim().length > 0)
        nextPrompt = body.prompt;
      else if (body.prompt === null || body.prompt === "")
        nextPrompt = undefined;
      else
        return jsonResponse({ error: "prompt must be a string or null" }, 400);
    }
    // Clearing the model always clears model-dependent settings before sync/effort gates.
    if (!nextModel) {
      nextEffort = undefined;
      nextSyncCodexSubagentDefaults = false;
    }
    if (body.syncCodexSubagentDefaults === true && !nextModel?.trim()) {
      return jsonResponse(
        { error: "syncCodexSubagentDefaults requires an injection model" },
        400,
      );
    }
    if (
      nextSyncCodexSubagentDefaults &&
      nextEffort !== undefined &&
      !isCodexReasoningEffort(nextEffort)
    ) {
      return jsonResponse(
        {
          error:
            "syncCodexSubagentDefaults requires a supported Codex reasoning effort",
        },
        400,
      );
    }

    config.multiAgentGuidanceEnabled = nextEnabled;
    if (nextSyncCodexSubagentDefaults) config.syncCodexSubagentDefaults = true;
    else delete config.syncCodexSubagentDefaults;
    if (nextModel) config.injectionModel = nextModel;
    else delete config.injectionModel;
    if (nextEffort) config.injectionEffort = nextEffort;
    else delete config.injectionEffort;
    if (nextPrompt) config.injectionPrompt = nextPrompt;
    else delete config.injectionPrompt;

    saveConfigPreservingClaudeCode(config);
    return jsonResponse({
      ok: true,
      multiAgentGuidanceEnabled: multiAgentGuidanceEnabled(config),
      syncCodexSubagentDefaults: subagentDefaultSyncEffective(config),
      model: config.injectionModel ?? null,
      effort: config.injectionEffort ?? null,
      prompt: config.injectionPrompt ?? null,
    });
  }

  // Hard reasoning-effort caps (devlog/260710_subagent_effort_intercept): a global ceiling and a
  // sub-agent-only ceiling, enforced per-request in handleResponses (src/server/effort-policy.ts).
  // Key semantics per field: absent -> unchanged; null/"" -> clear; ladder value -> set; else 400.
  if (url.pathname === "/api/effort-caps" && req.method === "GET") {
    const { CODEX_REASONING_LEVELS } = await import("../../reasoning-effort");
    return jsonResponse({
      effortCap: config.effortCap ?? null,
      subagentEffortCap: config.subagentEffortCap ?? null,
      efforts: CODEX_REASONING_LEVELS.map((l) => l.effort),
    });
  }
  if (url.pathname === "/api/effort-caps" && req.method === "PUT") {
    let body: { effortCap?: unknown; subagentEffortCap?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    const { isCodexReasoningEffort } = await import("../../reasoning-effort");
    for (const key of ["effortCap", "subagentEffortCap"] as const) {
      if (!(key in body)) continue;
      const value = body[key];
      if (value === null || value === "") {
        delete config[key];
        continue;
      }
      if (typeof value !== "string" || !isCodexReasoningEffort(value)) {
        return jsonResponse(
          { error: `unknown reasoning effort "${String(value)}"` },
          400,
        );
      }
      config[key] = value;
    }
    saveConfigPreservingClaudeCode(config);
    return jsonResponse({
      ok: true,
      effortCap: config.effortCap ?? null,
      subagentEffortCap: config.subagentEffortCap ?? null,
    });
  }

  // Subagent model picker: which ≤5 routed models Codex's spawn_agent advertises (it shows the
  // first 5 routed catalog entries). PUT reorders the injected catalog so the chosen ones lead.
  if (url.pathname === "/api/subagent-models" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    // Native gpt (passthrough) are also valid subagent picks — they're picker-visible models in the
    // catalog, just buried by priority. List them first so the user can feature them over routed.
    const { listCatalogNativeSlugs } = await import("../../codex/catalog");
    const visibleRouted = [
      ...new Set(
        models
          .filter(
            (m) =>
              ![...disabled].some(
                (stored) =>
                  stored === catalogModelSlug(m) ||
                  slugEquals(stored, m.provider, m.id),
              ),
          )
          .map(catalogModelSlug),
      ),
    ];
    const available = [
      ...listCatalogNativeSlugs().filter((ns) => !disabled.has(ns)),
      ...visibleRouted,
    ];
    return jsonResponse({ chosen: config.subagentModels ?? [], available });
  }
  if (url.pathname === "/api/subagent-models" && req.method === "PUT") {
    let body: { models?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    const chosen = Array.isArray(body.models)
      ? body.models
          .filter((m): m is string => typeof m === "string")
          .slice(0, 5)
      : [];
    config.subagentModels = chosen;
    const { saveConfigPreservingClaudeCode: save } =
      await import("../../config");
    save(config);
    await refreshCodexCatalogBestEffort();
    await syncClaudeAgentDefsBestEffort();
    await autoApplyDesktopBestEffort();
    return jsonResponse({ ok: true, applied: chosen });
  }

  // Priority-ordered subagent model fallback chain for quota-aware spawn routing.
  if (url.pathname === "/api/subagent-model-fallback" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    const { listCatalogNativeSlugs } = await import("../../codex/catalog");
    const visibleRouted = [
      ...new Set(
        models
          .filter(
            (m) =>
              ![...disabled].some(
                (stored) =>
                  stored === catalogModelSlug(m) ||
                  slugEquals(stored, m.provider, m.id),
              ),
          )
          .map(catalogModelSlug),
      ),
    ];
    const available = [
      ...listCatalogNativeSlugs().filter((ns) => !disabled.has(ns)),
      ...visibleRouted,
    ];
    return jsonResponse({
      models: config.subagentModelFallback ?? [],
      pollMs: config.subagentModelFallbackPollMs ?? 60_000,
      available,
    });
  }
  if (url.pathname === "/api/subagent-model-fallback" && req.method === "PUT") {
    let body: { models?: unknown; pollMs?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    let nextModels = config.subagentModelFallback;
    let nextPollMs = config.subagentModelFallbackPollMs;
    if ("models" in body) {
      if (!Array.isArray(body.models))
        return jsonResponse({ error: "models must be an array" }, 400);
      const models: string[] = [];
      for (let i = 0; i < body.models.length; i++) {
        const entry = body.models[i];
        if (typeof entry !== "string" || entry.trim().length === 0) {
          return jsonResponse(
            {
              error: `models[${i}] must be a non-empty string`,
              index: i,
              value: entry,
            },
            400,
          );
        }
        models.push(entry.trim());
      }
      nextModels = models.length > 0 ? models : undefined;
    }
    if ("pollMs" in body) {
      const pollMs = body.pollMs;
      if (pollMs === null || pollMs === "") nextPollMs = undefined;
      else if (
        typeof pollMs === "number" &&
        Number.isInteger(pollMs) &&
        pollMs >= 5_000 &&
        pollMs <= 600_000
      ) {
        nextPollMs = pollMs;
      } else {
        return jsonResponse(
          { error: "pollMs must be an integer between 5000 and 600000" },
          400,
        );
      }
    }
    if (nextModels !== undefined) config.subagentModelFallback = nextModels;
    else delete config.subagentModelFallback;
    if (nextPollMs !== undefined)
      config.subagentModelFallbackPollMs = nextPollMs;
    else delete config.subagentModelFallbackPollMs;
    saveConfigPreservingClaudeCode(config);
    return jsonResponse({
      ok: true,
      models: config.subagentModelFallback ?? [],
      pollMs: config.subagentModelFallbackPollMs ?? 60_000,
    });
  }

  // Grok management is a dedicated route group; preserve dispatch order.
  const grokResult = await handleGrokRoutes(ctx);
  if (grokResult) return grokResult;

  // Claude Desktop management belongs to its own credential-sensitive route group.
  const desktopResult = await handleClaudeDesktopRoutes(ctx);
  if (desktopResult) return desktopResult;

  // Keep the Claude Code configuration and migration route behind the existing auth gate.
  const codeResult = await handleClaudeCodeRoutes(ctx);
  if (codeResult) return codeResult;

  return null;
}
