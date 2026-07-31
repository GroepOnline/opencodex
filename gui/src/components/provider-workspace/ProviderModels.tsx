/**
 * ProviderModels — models tab: searchable chips with per-model on/off,
 * fetch/refresh, and 30d usage insight. Chip click still copies the id.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n, useT } from "../../i18n/shared";
import {
  modelVisible,
  putModelVisibility,
  type ProviderModelMap,
} from "../../model-visibility";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { filterModels } from "../../provider-workspace/report";
import { formatRequestCount, formatTokenCount } from "../../provider-workspace/usage";
import { Switch } from "../../ui";
import type { ProviderModelUsageRow } from "./types";

type CatalogRow = {
  provider: string;
  id: string;
  namespaced: string;
  disabled?: boolean;
  native?: boolean;
};

export default function ProviderModels({
  item,
  apiBase,
  availableModels,
  hasLiveModels,
  selectedModels,
  modelUsage,
  modelsLoading = false,
  modelsLoadFailed = false,
  needsReauth = false,
  onRetryModels,
  onOpenAccounts,
}: {
  item: WorkspaceItem;
  apiBase: string;
  availableModels: string[];
  selectedModels: string[];
  /** 30d per-model usage rows for this provider (from /api/usage). */
  modelUsage?: ProviderModelUsageRow[];
  /** Server-reported: did the last successful discovery return any rows? */
  hasLiveModels: boolean;
  modelsLoading?: boolean;
  modelsLoadFailed?: boolean;
  /** Active OAuth account needs a fresh login before live discovery works. */
  needsReauth?: boolean;
  onRetryModels?: () => void;
  onOpenAccounts?: () => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [query, setQuery] = useState("");
  const [customModelId, setCustomModelId] = useState("");
  const [customSaving, setCustomSaving] = useState(false);
  const [customError, setCustomError] = useState("");
  const [customSuccess, setCustomSuccess] = useState("");
  const [customModelIds, setCustomModelIds] = useState<string[]>([]);
  const [customModelsReady, setCustomModelsReady] = useState(false);
  const [customModelsLoadFailed, setCustomModelsLoadFailed] = useState(false);
  const [customModelsLoadEpoch, setCustomModelsLoadEpoch] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [disabledNamespaced, setDisabledNamespaced] = useState<Set<string>>(new Set());
  const [nativeIds, setNativeIds] = useState<Set<string>>(new Set());
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const [actionOk, setActionOk] = useState(true);
  const copyResetRef = useRef<number | null>(null);

  const selectedMap = useMemo<ProviderModelMap>(
    () => ({ [item.name]: selectedModels }),
    [item.name, selectedModels],
  );
  const configuredModels = useMemo(() => item.models ?? [], [item.models]);
  const usageById = useMemo(() => {
    const map = new Map<string, ProviderModelUsageRow>();
    for (const row of modelUsage ?? []) {
      const key = row.resolvedModel || row.model;
      const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
      // Prefer higher-token row if both namespaced and bare collide.
      const prev = map.get(bare);
      if (!prev || row.totalTokens > prev.totalTokens) map.set(bare, row);
      map.set(key, row);
    }
    return map;
  }, [modelUsage]);

  const trimmedCustomModelId = customModelId.trim();
  const customModelInvalid = !customModelsReady
    || !trimmedCustomModelId
    || trimmedCustomModelId.includes("/")
    || availableModels.includes(trimmedCustomModelId)
    || customModelIds.includes(trimmedCustomModelId)
    || configuredModels.includes(trimmedCustomModelId)
    || item.defaultModel === trimmedCustomModelId;
  const models = useMemo(
    () => filterModels(availableModels, item.defaultModel, query, configuredModels, customModelIds, hasLiveModels),
    [availableModels, item.defaultModel, query, configuredModels, customModelIds, hasLiveModels],
  );

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/api/custom-models`);
        if (!response.ok) throw new Error();
        const rows: unknown = await response.json();
        if (!Array.isArray(rows)) throw new Error("Invalid custom model list");
        if (!active) return;
        setCustomModelIds(rows.flatMap(row => {
          if (!row || typeof row !== "object") return [];
          const model = row as { provider?: unknown; modelId?: unknown };
          return model.provider === item.name && typeof model.modelId === "string" ? [model.modelId] : [];
        }));
        setCustomModelsLoadFailed(false);
        setCustomError("");
        setCustomModelsReady(true);
      } catch {
        if (!active) return;
        setCustomModelIds([]);
        setCustomModelsReady(false);
        setCustomModelsLoadFailed(true);
        setCustomError(t("models.networkError"));
      }
    };
    void load();
    return () => { active = false; };
  }, [apiBase, item.name, t, customModelsLoadEpoch]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/api/models`);
        if (!response.ok) throw new Error();
        const rows: unknown = await response.json();
        if (!Array.isArray(rows)) throw new Error("invalid models");
        if (!active) return;
        const blocked = new Set<string>();
        const natives = new Set<string>();
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const m = row as CatalogRow;
          if (m.provider !== item.name || typeof m.id !== "string") continue;
          if (m.native === true) natives.add(m.id);
          if (m.disabled === true) {
            if (typeof m.namespaced === "string") blocked.add(m.namespaced);
            blocked.add(m.id);
          }
        }
        setDisabledNamespaced(blocked);
        setNativeIds(natives);
      } catch {
        if (!active) return;
        /* keep last known disabled set */
      }
    };
    void load();
    return () => { active = false; };
  }, [apiBase, item.name, catalogEpoch]);

  const retryCustomModels = () => {
    setCustomModelsReady(false);
    setCustomModelsLoadFailed(false);
    setCustomError("");
    setCustomModelsLoadEpoch(epoch => epoch + 1);
  };

  useEffect(() => () => {
    if (copyResetRef.current != null) window.clearTimeout(copyResetRef.current);
  }, []);

  const copyModelId = async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      setCopiedId(modelId);
      if (copyResetRef.current != null) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => {
        setCopiedId(prev => (prev === modelId ? null : prev));
        copyResetRef.current = null;
      }, 1200);
    } catch {
      /* ignore clipboard failures */
    }
  };

  const isModelOn = (modelId: string) => modelVisible(
    selectedMap,
    item.name,
    modelId,
    nativeIds.has(modelId),
    disabledNamespaced.has(modelId) || disabledNamespaced.has(`${item.name}/${modelId}`),
  );

  const applyVisibility = async (targets: string[], enabled: boolean) => {
    setActionStatus("");
    try {
      const response = await putModelVisibility(
        apiBase,
        "models",
        item.name,
        targets.map(id => ({ id, native: nativeIds.has(id) })),
        enabled,
      );
      if (!response.ok) {
        setActionOk(false);
        setActionStatus(t("models.saveFailed"));
        return;
      }
      setActionOk(true);
      setActionStatus(t("models.applied"));
      setCatalogEpoch(epoch => epoch + 1);
      onRetryModels?.();
    } catch {
      setActionOk(false);
      setActionStatus(t("models.networkError"));
    }
  };

  const toggleModel = async (modelId: string) => {
    if (busyId || bulkBusy || fetching) return;
    const next = !isModelOn(modelId);
    setBusyId(modelId);
    // Optimistic disabled-set update for snappy chips.
    setDisabledNamespaced(prev => {
      const nextSet = new Set(prev);
      const namespaced = nativeIds.has(modelId) ? modelId : `${item.name}/${modelId}`;
      if (next) {
        nextSet.delete(modelId);
        nextSet.delete(namespaced);
      } else {
        nextSet.add(namespaced);
      }
      return nextSet;
    });
    await applyVisibility([modelId], next);
    setBusyId(null);
  };

  const bulkToggle = async (enable: boolean) => {
    if (bulkBusy || busyId || fetching || visibleModels.length === 0) return;
    setBulkBusy(true);
    await applyVisibility(visibleModels, enable);
    setBulkBusy(false);
  };

  const fetchModels = async () => {
    if (fetching || busyId || bulkBusy) return;
    setFetching(true);
    setActionStatus("");
    try {
      // Clears provider model caches server-side and refreshes the Codex catalog.
      const response = await fetch(`${apiBase}/api/sync`, { method: "POST" });
      if (!response.ok) {
        setActionOk(false);
        setActionStatus(t("dash.syncFailed", { error: `HTTP ${response.status}` }));
        return;
      }
      setActionOk(true);
      setActionStatus(t("dash.syncModels"));
      setCatalogEpoch(epoch => epoch + 1);
      onRetryModels?.();
    } catch {
      setActionOk(false);
      setActionStatus(t("models.networkError"));
    } finally {
      setFetching(false);
    }
  };

  const addCustomModel = async () => {
    if (customModelInvalid || customSaving) return;
    setCustomSaving(true);
    setCustomError("");
    setCustomSuccess("");
    try {
      const response = await fetch(`${apiBase}/api/custom-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: item.name, modelId: trimmedCustomModelId }),
      });
      if (response.ok) {
        setCustomModelIds(ids => ids.includes(trimmedCustomModelId) ? ids : [...ids, trimmedCustomModelId]);
        setCustomModelId("");
        setCustomSuccess(t("models.customAdded"));
        onRetryModels?.();
      } else {
        setCustomError(t("models.customSaveFailed"));
      }
    } catch {
      setCustomError(t("models.networkError"));
    } finally {
      setCustomSaving(false);
    }
  };

  const emptyBase = availableModels.length === 0
    && configuredModels.length === 0
    && customModelIds.length === 0
    && !item.defaultModel;
  const showingConfiguredFallback = availableModels.length === 0 && configuredModels.length > 0;
  const CHIP_RENDER_CAP = 300;
  const capped = models.length > CHIP_RENDER_CAP;
  const visibleModels = capped ? models.slice(0, CHIP_RENDER_CAP) : models;
  const allOn = visibleModels.length > 0 && visibleModels.every(isModelOn);
  const allOff = visibleModels.length > 0 && visibleModels.every(id => !isModelOn(id));
  const controlsBusy = Boolean(busyId) || bulkBusy || fetching;

  return (
    <div className="pws-section">
      <div className="pws-section-head">
        <h3 className="pws-section-title">{t("pws.tab.models")}</h3>
        <div className="pws-models-head-actions">
          {models.length > 0 && (
            <span className="muted">{t("pws.modelsAvailable", { count: models.length })}</span>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => { void fetchModels(); }}
            disabled={controlsBusy}
          >
            {fetching ? t("dash.syncing") : t("dash.syncModels")}
          </button>
        </div>
      </div>
      {actionStatus && (
        <p className="muted text-label" role="status" style={{ color: actionOk ? undefined : "var(--amber)" }}>
          {actionStatus}
        </p>
      )}
      {needsReauth && (
        <div className="pws-inline-error" role="status">
          <span>{t("pws.modelsNeedsReauth")}</span>
          {onOpenAccounts && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenAccounts}>
              {t("pws.tab.accounts")}
            </button>
          )}
        </div>
      )}
      {showingConfiguredFallback && !needsReauth && (
        <p className="muted text-label" style={{ marginBottom: 10 }}>{t("pws.modelsConfiguredFallback")}</p>
      )}
      <label className="text-label pws-custom-model-label" htmlFor={`pws-custom-model-${item.name}`}>
        {t("models.customAdd")}
      </label>
      <div className="row pws-custom-model-row">
        <input
          id={`pws-custom-model-${item.name}`}
          className="input"
          value={customModelId}
          onChange={event => setCustomModelId(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") void addCustomModel(); }}
          placeholder={t("models.customFieldModelIdPlaceholder")}
          aria-label={t("models.customAdd")}
          disabled={customSaving}
        />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => { void addCustomModel(); }}
          disabled={customSaving || customModelInvalid}
        >
          {customSaving ? t("models.customSaving") : t("models.customAddBtn")}
        </button>
      </div>
      {customSuccess && <p className="muted text-label" role="status">{customSuccess}</p>}
      {customError && (
        <p className="pws-inline-error" role="alert">
          {customError}
          {customModelsLoadFailed && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={retryCustomModels} style={{ marginLeft: 8 }}>
              {t("common.retry")}
            </button>
          )}
        </p>
      )}
      {!emptyBase && (
        <div className="pws-models-toolbar">
          <input
            type="search"
            className="input pws-model-search"
            placeholder={t("pws.modelSearchPlaceholder")}
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label={t("pws.modelSearchPlaceholder")}
          />
          <div className="pws-models-bulk">
            <button
              type="button"
              className="btn btn-ghost btn-sm text-caption"
              disabled={controlsBusy || allOn || visibleModels.length === 0}
              onClick={() => { void bulkToggle(true); }}
            >
              {t("models.allOn")}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm text-caption"
              disabled={controlsBusy || allOff || visibleModels.length === 0}
              onClick={() => { void bulkToggle(false); }}
            >
              {t("models.allOff")}
            </button>
          </div>
        </div>
      )}
      {modelsLoading && emptyBase ? (
        <p className="muted" role="status">{t("pws.modelsLoading")}</p>
      ) : modelsLoadFailed && emptyBase ? (
        <div role="alert" className="pws-inline-error">
          <span>{t("pws.modelsLoadFailed")}</span>
          {onRetryModels && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRetryModels}>
              {t("pws.retry")}
            </button>
          )}
        </div>
      ) : emptyBase ? (
        <p className="muted">{t("pws.noModels")}</p>
      ) : models.length === 0 ? (
        <p className="muted" role="status">{t("pws.noModelMatch")}</p>
      ) : (
        <ul className="pws-model-list">
          {visibleModels.map(modelId => {
            const isDefault = modelId === item.defaultModel;
            const on = isModelOn(modelId);
            const copied = copiedId === modelId;
            const usage = usageById.get(modelId) ?? usageById.get(`${item.name}/${modelId}`);
            const usageLabel = usage
              ? `${formatTokenCount(usage.totalTokens, locale)} · ${formatRequestCount(usage.requests, locale)}`
              : null;
            return (
              <li key={modelId} className={`pws-model-chip${on ? "" : " pws-model-chip-off"}`}>
                <Switch
                  on={on}
                  onClick={() => { void toggleModel(modelId); }}
                  disabled={controlsBusy}
                  label={modelId}
                />
                <button
                  type="button"
                  className="pws-model-chip-main"
                  onClick={() => { void copyModelId(modelId); }}
                  title={usageLabel ? `${modelId} — ${usageLabel}` : modelId}
                  aria-label={copied ? t("pws.modelCopied") : t("pws.copyModelId")}
                >
                  <span className="pws-model-id">{modelId}</span>
                  {usageLabel ? <span className="pws-model-usage muted text-caption">{usageLabel}</span> : null}
                </button>
                {isDefault ? <span className="badge badge-muted pws-model-flag">{t("prov.defaultBadge")}</span> : null}
                {busyId === modelId ? <span className="muted text-caption">…</span> : null}
              </li>
            );
          })}
        </ul>
      )}
      {capped && (
        <p className="muted text-label" style={{ marginTop: 10 }}>
          {t("pws.modelsTruncated", { shown: String(CHIP_RENDER_CAP), total: String(models.length) })}
        </p>
      )}
    </div>
  );
}
