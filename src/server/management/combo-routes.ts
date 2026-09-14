import {
  CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR,
  codexAccountNamespaceForModel,
} from "../../codex/account-namespace-match";
import { saveConfigPreservingClaudeCode } from "../../config";
import { jsonResponse } from "../auth-cors";
import { isPlainRecord } from "./shared";
import type { ManagementContext } from "./context";

const DYNAMIC_CLAUDE_AGENT_COMBO_ID = "claude-agent-dynamic-v1";

export async function handleComboRoutes(
  ctx: ManagementContext,
): Promise<Response | null> {
  const {
    req,
    url,
    config,
    refreshCodexCatalogBestEffort,
    syncClaudeAgentDefsBestEffort,
  } = ctx;

  if (url.pathname === "/api/combos" && req.method === "GET") {
    const { comboPublicModelId, getCombo, listComboIds } =
      await import("../../combos");
    const combos = listComboIds(config).filter(
      (id) => id !== DYNAMIC_CLAUDE_AGENT_COMBO_ID,
    );
    return jsonResponse({
      combos: combos.map((id) => {
        const combo = getCombo(config, id)!;
        return {
          id,
          model: comboPublicModelId(id, combo),
          ...combo,
        };
      }),
    });
  }

  if (url.pathname === "/api/combos" && req.method === "PUT") {
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (!isPlainRecord(rawBody)) {
      return jsonResponse({ error: "request body must be an object" }, 400);
    }
    const body = rawBody;
    if (typeof body.id !== "string" || !body.id.trim()) {
      return jsonResponse(
        { error: "id is required and must be a string" },
        400,
      );
    }
    const id = body.id.trim();

    let renameFrom: string | undefined;
    if (body.renameFrom !== undefined) {
      if (typeof body.renameFrom !== "string" || !body.renameFrom.trim()) {
        return jsonResponse(
          { error: "renameFrom must be a non-empty string" },
          400,
        );
      }
      renameFrom = body.renameFrom.trim();
      if (renameFrom === id) {
        return jsonResponse({ error: "renameFrom must differ from id" }, 400);
      }
    }

    if (
      renameFrom === DYNAMIC_CLAUDE_AGENT_COMBO_ID ||
      (renameFrom !== undefined && id === DYNAMIC_CLAUDE_AGENT_COMBO_ID)
    ) {
      return jsonResponse(
        {
          error: `cannot rename to/from the dynamic Claude agent combo "${DYNAMIC_CLAUDE_AGENT_COMBO_ID}"`,
        },
        403,
      );
    }

    if (id === DYNAMIC_CLAUDE_AGENT_COMBO_ID) {
      return jsonResponse(
        {
          error: `combo "${DYNAMIC_CLAUDE_AGENT_COMBO_ID}" is a reserved request-local combo that cannot be modified through the management API. This combo is created dynamically for Claude agent routing and should only be exposed as an implementation detail, not through the public management interface.`,
        },
        403,
      );
    }

    if (renameFrom !== undefined) {
      if (!Object.hasOwn(config.combos ?? {}, renameFrom)) {
        return jsonResponse(
          { error: `combo "${renameFrom}" does not exist` },
          400,
        );
      }
      if (Object.hasOwn(config.combos ?? {}, id)) {
        return jsonResponse({ error: `combo "${id}" already exists` }, 400);
      }
    }

    const {
      clearComboSelectionState,
      clearComboTargetCooldowns,
      comboConfigError,
      comboModelId,
      comboPublicModelId,
      normalizeComboConfig,
    } = await import("../../combos");
    const error = comboConfigError(id, body.combo, config.providers, {
      requireEnabledTarget: true,
      combos: config.combos,
      excludeComboId: renameFrom ?? id,
    });
    if (error) return jsonResponse({ error }, 400);

    const normalized = normalizeComboConfig(
      body.combo as import("../../types").OcxComboConfig,
    );
    const stored: import("../../types").OcxComboConfig =
      normalized.alias === null
        ? (({ alias: _alias, ...rest }) => rest)(normalized)
        : normalized;
    const sourceId = renameFrom ?? id;
    const previous = config.combos?.[sourceId];
    const oldPublicModel = previous
      ? comboPublicModelId(sourceId, previous)
      : null;
    const newPublicModel = comboPublicModelId(id, normalized);

    if (
      codexAccountNamespaceForModel(
        config.codexAccountNamespaces,
        newPublicModel,
      )
    ) {
      return jsonResponse(
        { error: CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR },
        409,
      );
    }

    const nextCombos = { ...(config.combos ?? {}) };
    if (renameFrom) delete nextCombos[renameFrom];
    nextCombos[id] = stored;
    config.combos = nextCombos;

    let shouldSyncClaudeAgentDefs = false;
    const migratedModels = new Set<string>();
    if (oldPublicModel && oldPublicModel !== newPublicModel) {
      migratedModels.add(oldPublicModel);
    }
    if (renameFrom) migratedModels.add(comboModelId(renameFrom));

    if (migratedModels.size > 0) {
      const migrateReference = (model: string): string =>
        migratedModels.has(model) ? newPublicModel : model;
      const migrateAgentReference = (model: string): string => {
        const migrated = migrateReference(model);
        if (migrated !== model) shouldSyncClaudeAgentDefs = true;
        return migrated;
      };
      const migrateReferences = (models: string[]): string[] => [
        ...new Set(models.map(migrateReference)),
      ];

      if (config.disabledModels) {
        config.disabledModels = migrateReferences(config.disabledModels);
      }
      if (config.subagentModels) {
        config.subagentModels = [
          ...new Set(config.subagentModels.map(migrateAgentReference)),
        ];
      }
      if (config.injectionModel && migratedModels.has(config.injectionModel)) {
        config.injectionModel = newPublicModel;
      }
      if (
        config.shadowCallIntercept?.model &&
        migratedModels.has(config.shadowCallIntercept.model)
      ) {
        config.shadowCallIntercept = {
          ...config.shadowCallIntercept,
          model: newPublicModel,
        };
      }
      if (config.claudeCode) {
        const claudeCode = { ...config.claudeCode };
        for (const field of ["model", "smallFastModel"] as const) {
          if (claudeCode[field]) {
            claudeCode[field] = migrateAgentReference(claudeCode[field]);
          }
        }
        if (claudeCode.tierModels) {
          claudeCode.tierModels = Object.fromEntries(
            Object.entries(claudeCode.tierModels).map(([tier, model]) => [
              tier,
              migrateAgentReference(model),
            ]),
          );
        }
        if (claudeCode.modelMap) {
          claudeCode.modelMap = Object.fromEntries(
            Object.entries(claudeCode.modelMap).map(([source, model]) => [
              source,
              migrateAgentReference(model),
            ]),
          );
        }
        config.claudeCode = claudeCode;
      }
    }

    saveConfigPreservingClaudeCode(config);
    clearComboSelectionState(id);
    clearComboTargetCooldowns(id);
    if (renameFrom) {
      clearComboSelectionState(renameFrom);
      clearComboTargetCooldowns(renameFrom);
    }
    await refreshCodexCatalogBestEffort();
    if (shouldSyncClaudeAgentDefs) await syncClaudeAgentDefsBestEffort();

    return jsonResponse({
      success: true,
      id,
      model: newPublicModel,
      combo: normalized,
    });
  }

  if (url.pathname === "/api/combos" && req.method === "DELETE") {
    const id = url.searchParams.get("id")?.trim();
    if (!id) return jsonResponse({ error: "id query param is required" }, 400);

    if (id === DYNAMIC_CLAUDE_AGENT_COMBO_ID) {
      return jsonResponse(
        {
          error: `combo "${DYNAMIC_CLAUDE_AGENT_COMBO_ID}" is a reserved request-local combo that cannot be deleted through the management API. This combo is created dynamically for Claude agent routing and should only be exposed as an implementation detail, not through the public management interface.`,
        },
        403,
      );
    }

    if (!Object.hasOwn(config.combos ?? {}, id)) {
      return jsonResponse({ error: "unknown combo" }, 404);
    }
    const { clearComboSelectionState, clearComboTargetCooldowns } =
      await import("../../combos");
    delete config.combos![id];
    if (Object.keys(config.combos!).length === 0) delete config.combos;
    saveConfigPreservingClaudeCode(config);
    clearComboSelectionState(id);
    clearComboTargetCooldowns(id);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true, id });
  }

  return null;
}
