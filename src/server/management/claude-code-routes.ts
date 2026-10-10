import { slugEquals } from "../../providers/slug-codec";
import type { OcxClaudeCodeConfig } from "../../types";
import { jsonResponse } from "../auth-cors";
import { applySystemEnvToggle } from "../system-env";
import { fetchAllModels } from "./shared";
import type { ManagementContext } from "./context";

/** Claude Code preference and auth-mode management, behind the top-level authentication gate. */
export async function handleClaudeCodeRoutes(
  ctx: ManagementContext,
): Promise<Response | null> {
  const { req, url, config, syncClaudeAgentDefsBestEffort } = ctx;

  // Claude Code inbound settings (GUI "Claude ON" toggle + Claude page).
  if (url.pathname === "/api/claude-code" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const { listCatalogNativeSlugs } = await import("../../codex/catalog");
    const { claudeCodeAlias, claudeCodeNativeAlias } =
      await import("../../claude/alias");
    const { buildClaudeContextWindows, effectiveModelEnv } =
      await import("../../claude/context-windows");
    const { visibleNativeSlugs } = await import("../../codex/catalog");
    const disabled = new Set(config.disabledModels ?? []);
    const isDisabled = (provider: string, id: string) =>
      [...disabled].some((stored) => slugEquals(stored, provider, id));
    const available = [
      ...listCatalogNativeSlugs().filter((ns) => !disabled.has(ns)),
      // Claude-facing values stay RAW native selectors (resolved inbound via routeModel,
      // which accepts the raw full-slash form); only the disabled check goes tolerant.
      ...models
        .filter((m) => !isDisabled(m.provider, m.id))
        .map((m) => `${m.provider}/${m.id}`),
    ];
    const aliases: { id: string; display_name: string }[] = [];
    for (const slug of listCatalogNativeSlugs()) {
      // Readable CLI-surface alias with hash fallback (devlog 050 / audit 051 #2) —
      // the same shared helper the /v1/models ?ids=cli path uses.
      if (!disabled.has(slug))
        aliases.push({
          id: claudeCodeNativeAlias(slug),
          display_name: `${slug} (native)`,
        });
    }
    for (const m of models) {
      if (isDisabled(m.provider, m.id)) continue;
      aliases.push({
        id: claudeCodeAlias(m.provider, m.id),
        display_name: `${m.id} (${m.provider})`,
      });
    }
    const contextWindows = buildClaudeContextWindows(
      [...visibleNativeSlugs(config)],
      models,
    );
    const webSearchOverride = config.claudeCode?.webSearchSidecar;
    const visionOverride = config.claudeCode?.visionSidecar;
    // Auto is a RESOLUTION, recomputed per request — never stored state. Detection is
    // daemon-side, so it cannot see a key exported only in the user's terminal; the
    // GUI labels the badge with detectionScope for exactly that reason.
    const { defaultAuthDetectDeps, detectClaudeAuth, ownAdmissionTokens } =
      await import("../../claude/auth-detect");
    const { authModeIntent, resolveClaudeAuthMode } =
      await import("../../claude/auth-mode");
    const authDetection = detectClaudeAuth(
      defaultAuthDetectDeps(process.env, ownAdmissionTokens(config)),
    );
    const resolvedAuthMode = resolveClaudeAuthMode(config, authDetection);
    return jsonResponse({
      enabled: config.claudeCode?.enabled !== false,
      // Three-state intent (devlog 260726_claude_auth_auto): an absent key is AUTO, not
      // subscription. The old coercion made every save convert an untouched auto config
      // into a sticky manual subscription with no way back.
      authMode: authModeIntent(config),
      /** Does the opencodex dummy marker get injected — NOT a claim about native auth. */
      markerMode: resolvedAuthMode.markerMode,
      authModeOrigin: resolvedAuthMode.origin,
      ...(resolvedAuthMode.foundBy
        ? { authFoundBy: resolvedAuthMode.foundBy }
        : {}),
      authDetectionUnknown: authDetection.presence === "unknown",
      // Separate axis: with an admission key configured a token is injected regardless
      // of mode, so the GUI must never present subscription as "no token anywhere".
      admissionKeyActive: (config.apiKeys?.length ?? 0) > 0,
      detectionScope: "daemon",
      model: config.claudeCode?.model ?? "",
      smallFastModel: config.claudeCode?.smallFastModel ?? "",
      tierModels: config.claudeCode?.tierModels ?? {},
      modelMap: config.claudeCode?.modelMap ?? {},
      systemEnv: config.claudeCode?.systemEnv === true,
      autoConnectSupported: process.platform === "darwin",
      maxContextTokens: config.claudeCode?.maxContextTokens ?? null,
      alwaysEnableEffort: config.claudeCode?.alwaysEnableEffort === true,
      autoContext: config.claudeCode?.autoContext !== false,
      autoCompactWindow: config.claudeCode?.autoCompactWindow ?? null,
      blockedSkills: config.claudeCode?.blockedSkills ?? null,
      injectAgents: config.claudeCode?.injectAgents !== false,
      agentRouting: config.claudeCode?.agentRouting ?? "pinned",
      ...(webSearchOverride && Object.keys(webSearchOverride).length > 0
        ? {
            webSearchSidecar: {
              backend: webSearchOverride.backend,
              model: webSearchOverride.model,
            },
          }
        : {}),
      ...(visionOverride && Object.keys(visionOverride).length > 0
        ? {
            visionSidecar: {
              backend: visionOverride.backend,
              model: visionOverride.model,
            },
          }
        : {}),
      fastMode: config.fastMode,
      contextWindows,
      effectiveModelEnv: effectiveModelEnv(config.claudeCode, contextWindows),
      available,
      aliases,
      port: config.port,
    });
  }
  if (url.pathname === "/api/claude-code" && req.method === "PUT") {
    // NOTE: model / tierModels / maxContextTokens / alwaysEnableEffort are
    // CONFIG-ONLY back-compat fields — the GUI no longer offers controls for them
    // (default model is owned by Claude Code's /model picker; roster agents
    // supersede tiers; auto-context supersedes the max-context pair; effort rides
    // regardless on 2.1.207). PUT keeps validating them so hand-written configs
    // and older GUIs stay safe; GUI saves omit them and the spread preserves them.
    let parsedBody: unknown;
    try {
      parsedBody = await req.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    const isPlainObject = (
      value: unknown,
    ): value is Record<string, unknown> => {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    };
    if (!isPlainObject(parsedBody))
      return jsonResponse({ error: "body must be an object" }, 400);
    const body = parsedBody as {
      enabled?: unknown;
      authMode?: unknown;
      model?: unknown;
      smallFastModel?: unknown;
      modelMap?: unknown;
      systemEnv?: unknown;
      fastMode?: unknown;
      maxContextTokens?: unknown;
      alwaysEnableEffort?: unknown;
      tierModels?: unknown;
      autoContext?: unknown;
      autoCompactWindow?: unknown;
      blockedSkills?: unknown;
      injectAgents?: unknown;
      agentRouting?: unknown;
      webSearchSidecar?: unknown;
      visionSidecar?: unknown;
    };
    for (const field of ["webSearchSidecar", "visionSidecar"] as const) {
      const section = body[field];
      if (section === undefined || section === null) continue;
      if (!isPlainObject(section))
        return jsonResponse(
          { error: `${field} must be an object or null` },
          400,
        );
      if (
        section.backend !== undefined &&
        section.backend !== null &&
        section.backend !== "openai" &&
        section.backend !== "anthropic"
      ) {
        return jsonResponse(
          { error: `${field}.backend must be openai, anthropic, or null` },
          400,
        );
      }
      if (section.model !== undefined && typeof section.model !== "string") {
        return jsonResponse({ error: `${field}.model must be a string` }, 400);
      }
    }
    const next = { ...(config.claudeCode ?? {}) };
    for (const field of ["webSearchSidecar", "visionSidecar"] as const) {
      const section = body[field];
      if (section === undefined) continue;
      if (
        section === null ||
        Object.keys(section as Record<string, unknown>).length === 0
      ) {
        delete next[field];
        continue;
      }
      const requested = section as {
        backend?: "openai" | "anthropic" | null;
        model?: string;
      };
      const override: NonNullable<OcxClaudeCodeConfig[typeof field]> = {
        ...next[field],
      };
      if (requested.backend === null) delete override.backend;
      else if (requested.backend !== undefined)
        override.backend = requested.backend;
      if (requested.model === "") delete override.model;
      else if (requested.model !== undefined) override.model = requested.model;
      if (Object.keys(override).length > 0) next[field] = override;
      else delete next[field];
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean")
        return jsonResponse({ error: "enabled must be a boolean" }, 400);
      next.enabled = body.enabled;
    }
    if (body.authMode !== undefined) {
      // Three-state intent: "proxy" and "subscription" are stored literally and stick
      // forever; "auto" DELETES the key so the mode is resolved from detected Claude
      // auth on every launch. The 260720 round-trip contract survives as a superset —
      // storing "subscription" literally is also backward-safe, since older readers
      // only ever recognised "proxy".
      if (
        body.authMode !== "proxy" &&
        body.authMode !== "subscription" &&
        body.authMode !== "auto"
      ) {
        return jsonResponse(
          { error: 'authMode must be "auto", "proxy", or "subscription"' },
          400,
        );
      }
      if (body.authMode === "auto") delete next.authMode;
      else next.authMode = body.authMode;
    }
    if (body.systemEnv !== undefined) {
      if (typeof body.systemEnv !== "boolean")
        return jsonResponse({ error: "systemEnv must be a boolean" }, 400);
      next.systemEnv = body.systemEnv;
    }
    if (body.alwaysEnableEffort !== undefined) {
      if (typeof body.alwaysEnableEffort !== "boolean")
        return jsonResponse(
          { error: "alwaysEnableEffort must be a boolean" },
          400,
        );
      if (body.alwaysEnableEffort) next.alwaysEnableEffort = true;
      else delete next.alwaysEnableEffort;
    }
    if (body.maxContextTokens !== undefined) {
      // CONFIG-ONLY back-compat (GUI control removed — superseded by auto-context):
      // null clears; otherwise a positive integer (devlog 136 B6).
      if (body.maxContextTokens === null) {
        delete next.maxContextTokens;
      } else if (
        typeof body.maxContextTokens !== "number" ||
        !Number.isInteger(body.maxContextTokens) ||
        body.maxContextTokens <= 0
      ) {
        return jsonResponse(
          { error: "maxContextTokens must be a positive integer or null" },
          400,
        );
      } else {
        next.maxContextTokens = body.maxContextTokens;
      }
    }
    if (body.autoContext !== undefined) {
      // Default-on boolean (devlog 260712 020): true = drop the key, false = store.
      if (typeof body.autoContext !== "boolean")
        return jsonResponse({ error: "autoContext must be a boolean" }, 400);
      if (body.autoContext) delete next.autoContext;
      else next.autoContext = false;
    }
    if (body.injectAgents !== undefined) {
      // Default-on boolean (devlog 260712 070): true = drop the key, false = store.
      if (typeof body.injectAgents !== "boolean")
        return jsonResponse({ error: "injectAgents must be a boolean" }, 400);
      if (body.injectAgents) delete next.injectAgents;
      else next.injectAgents = false;
    }
    if (body.agentRouting !== undefined) {
      if (body.agentRouting !== "pinned" && body.agentRouting !== "dynamic") {
        return jsonResponse(
          { error: 'agentRouting must be "pinned" or "dynamic"' },
          400,
        );
      }
      if (body.agentRouting === "pinned") delete next.agentRouting;
      else next.agentRouting = "dynamic";
    }
    if (body.autoCompactWindow !== undefined) {
      // null resets to the 350k default; otherwise the binary-accepted range
      // 100_000..1_000_000 (2.1.207 pSo/yDs — audit 021 #1).
      if (body.autoCompactWindow === null) {
        delete next.autoCompactWindow;
      } else if (
        typeof body.autoCompactWindow !== "number" ||
        !Number.isInteger(body.autoCompactWindow) ||
        body.autoCompactWindow < 100_000 ||
        body.autoCompactWindow > 1_000_000
      ) {
        return jsonResponse(
          {
            error:
              "autoCompactWindow must be an integer between 100000 and 1000000, or null",
          },
          400,
        );
      } else {
        next.autoCompactWindow = body.autoCompactWindow;
      }
    }
    if (body.blockedSkills !== undefined) {
      // null resets to the default (["claude-api"]); an array (possibly empty = off)
      // must contain non-empty strings (devlog 060).
      if (body.blockedSkills === null) {
        delete next.blockedSkills;
      } else if (
        !Array.isArray(body.blockedSkills) ||
        body.blockedSkills.some((s) => typeof s !== "string" || s.trim() === "")
      ) {
        return jsonResponse(
          {
            error:
              "blockedSkills must be an array of non-empty strings, or null",
          },
          400,
        );
      } else {
        next.blockedSkills = (body.blockedSkills as string[]).map((s) =>
          s.trim(),
        );
      }
    }
    if (body.tierModels !== undefined) {
      // CONFIG-ONLY back-compat (GUI pickers removed — roster agents supersede tiers).
      if (body.tierModels === null) {
        delete next.tierModels;
      } else if (!isPlainObject(body.tierModels)) {
        return jsonResponse(
          { error: "tierModels must be an object with string values, or null" },
          400,
        );
      } else {
        for (const [tier, value] of Object.entries(body.tierModels)) {
          if (typeof value !== "string")
            return jsonResponse(
              { error: `tierModels.${tier} must be a string` },
              400,
            );
        }
        const tierModels = body.tierModels as Record<string, string>;
        const tiers: Record<string, string> = {};
        for (const tier of ["opus", "sonnet", "haiku", "fable"] as const) {
          const value = tierModels[tier];
          if (value !== undefined && value.trim() !== "")
            tiers[tier] = value.trim();
        }
        if (Object.keys(tiers).length > 0) next.tierModels = tiers;
        else delete next.tierModels;
      }
    }
    if (body.fastMode !== undefined) {
      if (
        body.fastMode !== true &&
        body.fastMode !== false &&
        body.fastMode !== null
      ) {
        return jsonResponse(
          { error: "fastMode must be true, false, or null" },
          400,
        );
      }
      config.fastMode = body.fastMode === null ? undefined : body.fastMode;
    }
    for (const field of ["model", "smallFastModel"] as const) {
      const value = body[field];
      if (value === undefined) continue;
      if (typeof value !== "string")
        return jsonResponse({ error: `${field} must be a string` }, 400);
      if (value.trim() === "") delete next[field];
      else next[field] = value.trim();
    }
    if (body.modelMap !== undefined) {
      if (body.modelMap === null) {
        delete next.modelMap;
      } else {
        if (!isPlainObject(body.modelMap)) {
          return jsonResponse(
            { error: "modelMap must be an object of string->string, or null" },
            400,
          );
        }
        const map: Record<string, string> = {};
        for (const [k, v] of Object.entries(body.modelMap)) {
          if (typeof v !== "string" || k.trim() === "" || v.trim() === "") {
            return jsonResponse(
              { error: "modelMap entries must be non-empty strings" },
              400,
            );
          }
          map[k.trim()] = v.trim();
        }
        if (Object.keys(map).length > 0) next.modelMap = map;
        else delete next.modelMap;
      }
    }
    config.claudeCode = next;
    // Stamp the migration sentinel on EVERY persist of this block. The migration reads
    // "a claudeCode block with no authMode" as a pre-upgrade subscriber and pins it to
    // literal subscription — correct for a config written before `auto` existed, fatal
    // for one written after. Without this, choosing Auto (which DELETES authMode) or
    // merely toggling Claude on (App.tsx PUTs `{enabled}` alone and creates the block)
    // would be converted into a sticky manual subscription by the next startServer, and
    // auto would survive exactly one proxy lifetime with no way back.
    if (!next.authModeMigratedAt)
      next.authModeMigratedAt = new Date().toISOString();
    const { saveConfigPreservingClaudeCode: save } =
      await import("../../config");
    save(config);
    const warnings: string[] = [];
    // authMode changes must reconcile the injected system env too: switching back to
    // Subscription has to remove the opencodex-owned dummy ANTHROPIC_AUTH_TOKEN
    // (audit R1 blocker #1/#2, devlog 260720_claude_authmode_persist).
    if (body.systemEnv !== undefined || body.authMode !== undefined) {
      try {
        await applySystemEnvToggle(config, config.port);
      } catch (err) {
        warnings.push(
          `Failed to apply system environment setting: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Keep the file-backed live registry symmetric: OFF prunes immediately, while
    // ON and config changes restore definitions without requiring a restart.
    await syncClaudeAgentDefsBestEffort();
    return jsonResponse({
      ok: true,
      enabled: next.enabled !== false,
      warnings,
    });
  }
  return null;
}
