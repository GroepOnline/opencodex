import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/primitives/button";
import { Spinner } from "../components/primitives/spinner";
import { Alert, AlertDescription } from "../components/primitives/alert";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyContent,
  EmptyDescription,
} from "../components/primitives/empty";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "../components/primitives/input-group";
import {
  Select as LibrarySelect,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "../components/primitives/select";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../components/primitives/accordion";
import { SearchIcon, XIcon } from "lucide-react";
import { IconChevron, IconBoxes } from "../icons";
import { useT } from "../i18n/shared";
import type { TFn } from "../i18n/shared";
import { type ComboItem, parseComboList } from "../combo-workspace-data";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import {
  readSessionListCache,
  writeSessionListCache,
} from "../session-list-cache";
import {
  buildProviderModelGroups,
  type ConfiguredProviderSummary,
  type ProviderModelGroup,
} from "../models-groups";
import {
  fetchSelectedModels,
  modelVisible,
  putModelVisibility,
  shouldApplyLoadGeneration,
  type ProviderModelMap,
  type ModelVisibilityScope,
  type ModelVisibilityTarget,
} from "../model-visibility";
import {
  activeModelOptions,
  collectDisabledNamespaced,
  CUSTOM_OPTION,
  PAGE,
  readCollapsedProviders,
  readCombosOpen,
  writeCollapsedProviders,
  writeCombosOpen,
  type ModelRow,
  type ProviderContextCapsResponse,
  type ShadowCallData,
  type V2Status,
} from "./models-shared";
import { ModelsProviderCard } from "./models-provider-card";
import {
  ModelsAdvancedControls,
  ModelsShadowControls,
} from "./models-advanced-controls";
import { ModelsCombosSummary } from "./models-combos-summary";
import { ModelsModals } from "./models-modals";
import ModelInspector from "./ModelInspector";
import { refreshProviderModels } from "../provider-workspace/refresh-models";

type CachedModelsPage = {
  models: ModelRow[];
  providers: ConfiguredProviderSummary[];
  selectedModels: ProviderModelMap;
  disabled: string[];
  contextCaps: Record<string, number>;
  contextCapValue: number;
};

function assertCatalogPayload<T>(payload: T | undefined): asserts payload is T {
  if (payload === undefined) throw new Error("models payload missing");
}

function configuredContextCapValue(
  capsData: ProviderContextCapsResponse,
): number | undefined {
  return typeof capsData.value === "number" &&
    Number.isFinite(capsData.value) &&
    capsData.value > 0
    ? capsData.value
    : typeof capsData.cap === "number" &&
        Number.isFinite(capsData.cap) &&
        capsData.cap > 0
      ? capsData.cap
      : undefined;
}

export default function Models({ apiBase }: { apiBase: string }) {
  const t: TFn = useT();
  const cacheKey = `ocx.models.catalog.v1:${apiBase}`;
  const cached = readSessionListCache<CachedModelsPage>(cacheKey);
  const hasCacheRef = useRef(Boolean(cached));
  const [models, setModels] = useState<ModelRow[]>(() => cached?.models ?? []);
  const [providers, setProviders] = useState<ConfiguredProviderSummary[]>(
    () => cached?.providers ?? [],
  );
  const [disabled, setDisabled] = useState<Set<string>>(
    () => new Set(cached?.disabled ?? []),
  );
  const [selectedModels, setSelectedModels] = useState<ProviderModelMap | null>(
    () => cached?.selectedModels ?? null,
  );
  const [catalogQuery, setCatalogQuery] = useState("");
  const [limit, setLimit] = useState<Record<string, number>>({});
  const [contextCaps, setContextCaps] = useState<Record<string, number>>(
    () => cached?.contextCaps ?? {},
  );
  const [contextCapValue, setContextCapValue] = useState(
    () => cached?.contextCapValue ?? 350_000,
  );
  const [customCap, setCustomCap] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const initialCollapsed = readCollapsedProviders();
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => initialCollapsed ?? new Set(),
  );
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(() => !cached);
  const [busy, setBusy] = useState(false);
  const [fetchingProvider, setFetchingProvider] = useState<string | null>(null);
  const busyRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const loadPendingRef = useRef(false);
  // multi_agent_v2 / ultra gate. null = endpoint unavailable (older proxy build) -> section hidden.
  const [v2, setV2] = useState<V2Status | null>(null);
  const [v2Busy, setV2Busy] = useState(false);
  const [v2Note, setV2Note] = useState("");
  const v2BusyRef = useRef(false);
  const [threadsCustom, setThreadsCustom] = useState("");
  const [showThreadsCustom, setShowThreadsCustom] = useState(false);
  const [v2HelpOpen, setV2HelpOpen] = useState(false);
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [customModalMode, setCustomModalMode] = useState<"add" | "edit">("add");
  const [customModalProvider, setCustomModalProvider] = useState("");
  const [customModalId, setCustomModalId] = useState("");
  const [customFormModelId, setCustomFormModelId] = useState("");
  const [customFormDisplayName, setCustomFormDisplayName] = useState("");
  const [customFormContextWindow, setCustomFormContextWindow] = useState("");
  const [customFormShowCustomCtx, setCustomFormShowCustomCtx] = useState(false);
  const [customFormModalities, setCustomFormModalities] = useState<string[]>([
    "text",
  ]);
  const [customSaving, setCustomSaving] = useState(false);
  const [customError, setCustomError] = useState("");
  const [selectedModelName, updateSelectedModelName] = useState<string | null>(
    null,
  );
  const selectedModelNameRef = useRef<string | null>(null);
  const setSelectedModelName = useCallback((name: string | null) => {
    selectedModelNameRef.current = name;
    updateSelectedModelName(name);
  }, []);
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  const catalogSearchRef = useRef<HTMLInputElement | null>(null);
  const [shadowCall, setShadowCall] = useState<ShadowCallData | null>(null);
  const [shadowCallSaving, setShadowCallSaving] = useState(false);
  // Combo summary section. null = loading or failed (section hidden on failure —
  // an API error must never masquerade as "no combos configured").
  const [combos, setCombos] = useState<ComboItem[] | null>(null);
  const [combosError, setCombosError] = useState(false);
  const [combosOpen, setCombosOpen] = useState(readCombosOpen);

  // App owns the in-session view mode; fallback to persisted mode for isolated renders/tests.
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const toggleCombosOpen = () => {
    const next = !combosOpen;
    writeCombosOpen(next);
    setCombosOpen(next);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`${apiBase}/api/combos`);
        const j = await readJsonOrThrow<unknown>(r);
        if (!cancelled) {
          setCombos(parseComboList(j));
          setCombosError(false);
        }
      } catch {
        if (!cancelled) {
          setCombos(null);
          setCombosError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  const shadowModelOptions = useMemo(
    () => activeModelOptions(models, disabled, selectedModels ?? {}),
    [models, disabled, selectedModels],
  );

  const loadShadowCall = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/api/shadow-call-settings`);
      const data = await readJsonIfOk<ShadowCallData>(r);
      if (data) setShadowCall(data);
    } catch {
      /* old server / network: keep the section disabled */
    }
  }, [apiBase]);

  const loadV2 = useCallback(async () => {
    // Never let a toggle in flight be clobbered by the poll (same single-flight rule as models).
    if (v2BusyRef.current) return;
    try {
      const r = await fetch(`${apiBase}/api/v2`);
      if (!(r.headers.get("content-type") ?? "").includes("application/json")) {
        setV2(null);
        return;
      }
      const data = await readJsonIfOk<V2Status>(r);
      if (!data || typeof data.enabled !== "boolean") {
        setV2(null);
        return;
      }
      setV2({
        enabled: data.enabled,
        agentsMaxThreadsConflict: data.agentsMaxThreadsConflict === true,
        maxConcurrentThreadsPerSession:
          typeof data.maxConcurrentThreadsPerSession === "number"
            ? data.maxConcurrentThreadsPerSession
            : null,
        multiAgentMode:
          data.multiAgentMode === "v1" || data.multiAgentMode === "v2"
            ? data.multiAgentMode
            : "default",
      });
    } catch {
      setV2(null); // old server / network: hide the section instead of guessing
    }
  }, [apiBase]);

  const clearMissingSelection = useCallback(
    (nextGroups: ProviderModelGroup<ModelRow>[]) => {
      const selectedName = selectedModelNameRef.current;
      if (
        selectedName &&
        !nextGroups.some((group) =>
          group.rows.some((model) => model.namespaced === selectedName),
        )
      ) {
        const restoreFocus = Boolean(
          document.activeElement?.closest("#model-inspector"),
        );
        setSelectedModelName(null);
        if (restoreFocus)
          requestAnimationFrame(() => catalogSearchRef.current?.focus());
      }
    },
    [setSelectedModelName],
  );

  const load = useCallback(
    async (force = false): Promise<boolean> => {
      if (loadPendingRef.current && !force) return false;
      loadPendingRef.current = true;
      const generation = ++loadGenerationRef.current;
      // Soft refresh: keep last-good catalog painted while revalidating.
      if (!hasCacheRef.current) setLoading(true);
      try {
        const [modelsRes, capsRes, providersRes, selectionData] =
          await Promise.all([
            fetch(`${apiBase}/api/models`),
            fetch(`${apiBase}/api/provider-context-caps`),
            fetch(`${apiBase}/api/providers`),
            fetchSelectedModels(apiBase),
          ]);
        const [data, capsData, providerData] = await Promise.all([
          readJsonOrThrow<ModelRow[]>(modelsRes),
          readJsonOrThrow<ProviderContextCapsResponse>(capsRes),
          readJsonOrThrow<ConfiguredProviderSummary[]>(providersRes),
        ]);
        assertCatalogPayload(data);
        assertCatalogPayload(capsData);
        assertCatalogPayload(providerData);
        if (!shouldApplyLoadGeneration(generation, loadGenerationRef.current))
          return false;
        const nextGroups = buildProviderModelGroups(data, providerData);
        clearMissingSelection(nextGroups);
        setSelectedProvider((prev) =>
          prev !== null && !nextGroups.some((group) => group.provider === prev)
            ? null
            : prev,
        );
        const nextDisabled = collectDisabledNamespaced(data);
        const value = configuredContextCapValue(capsData);
        const nextCapValue = value !== undefined ? value : 350_000;
        const nextCaps = capsData.caps ?? {};
        setModels(data);
        setProviders(providerData);
        setDisabled(nextDisabled);
        setSelectedModels(selectionData);
        if (value !== undefined) setContextCapValue(value);
        setContextCaps(nextCaps);
        hasCacheRef.current = true;
        writeSessionListCache(cacheKey, {
          models: data,
          providers: providerData,
          selectedModels: selectionData,
          disabled: [...nextDisabled],
          contextCaps: nextCaps,
          contextCapValue: nextCapValue,
        } satisfies CachedModelsPage);
        return true;
      } catch {
        if (
          shouldApplyLoadGeneration(generation, loadGenerationRef.current) &&
          !hasCacheRef.current
        ) {
          setOk(false);
          setStatus(t("models.loadFail"));
        }
        return false;
      } finally {
        if (shouldApplyLoadGeneration(generation, loadGenerationRef.current)) {
          loadPendingRef.current = false;
          setLoading(false);
        }
      }
    },
    [apiBase, cacheKey, clearMissingSelection, t],
  );

  // Shadow/v2 controls must not wait on the models catalog (live discovery can be slow).
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadShadowCall();
      void loadV2();
    }, 0);
    const timer = window.setInterval(() => {
      if (!v2BusyRef.current) void loadV2();
    }, 10000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(timer);
    };
  }, [loadShadowCall, loadV2]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    // Provider models resolve lazily (live /models + OAuth tokens), so a provider that wasn't ready
    // on first load (e.g. anthropic right after login) would otherwise stay missing until a manual
    // remove/re-add. Re-poll to pick it up; skip while a toggle PUT is in flight to avoid clobbering.
    const timer = window.setInterval(() => {
      if (!busyRef.current) {
        void load();
      }
    }, 10000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(timer);
    };
  }, [load]);

  const groups = useMemo(
    () => buildProviderModelGroups(models, providers),
    [models, providers],
  );

  const effectiveVisibleCount = useMemo(() => {
    if (!selectedModels) return 0;
    return models.filter((model) =>
      modelVisible(
        selectedModels,
        model.provider,
        model.id,
        model.native === true,
        disabled.has(model.namespaced),
      ),
    ).length;
  }, [disabled, models, selectedModels]);

  const applyVisibility = async (
    scope: ModelVisibilityScope,
    provider: string,
    targets: ModelVisibilityTarget[],
    enabled: boolean,
  ) => {
    ++loadGenerationRef.current;
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    let errorKey: "models.saveFailed" | "models.networkError" | null = null;
    try {
      const response = await putModelVisibility(
        apiBase,
        scope,
        provider,
        targets,
        enabled,
      );
      if (!response.ok) errorKey = "models.saveFailed";
    } catch {
      errorKey = "models.networkError";
    } finally {
      const refreshed = await load(true);
      if (errorKey) {
        setOk(false);
        setStatus(t(errorKey));
      } else if (refreshed) {
        setOk(true);
        setStatus(t("models.applied"));
      }
      setBusy(false);
      busyRef.current = false;
    }
  };

  const toggleProviderCap = async (provider: string) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    const enabled = contextCaps[provider] !== contextCapValue;
    try {
      const r = await fetch(`${apiBase}/api/provider-context-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, enabled }),
      });
      try {
        const data = await readJsonOrThrow<ProviderContextCapsResponse>(
          r,
          t("models.capSaveFailed"),
        );
        setContextCaps(data?.caps ?? {});
        setOk(true);
        setStatus(t("models.capApplied"));
        await load(true);
      } catch (e) {
        setOk(false);
        setStatus(e instanceof Error ? e.message : t("models.capSaveFailed"));
      }
    } catch {
      setOk(false);
      setStatus(t("models.networkError"));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };
  const toggleCollapse = (p: string) => {
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      writeCollapsedProviders(n);
      return n;
    });
  };
  const setAllCollapsed = (collapse: boolean) => {
    setCollapsed(() => {
      const n = collapse
        ? new Set(groups.map((group) => group.provider))
        : new Set<string>();
      writeCollapsedProviders(n);
      return n;
    });
  };

  const putCap = async (body: Record<string, unknown>) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/provider-context-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      try {
        const data = await readJsonOrThrow<ProviderContextCapsResponse>(
          r,
          t("models.capSaveFailed"),
        );
        if (
          typeof data?.value === "number" &&
          Number.isFinite(data.value) &&
          data.value > 0
        )
          setContextCapValue(data.value);
        setContextCaps(data?.caps ?? {});
        setOk(true);
        setStatus(t("models.capApplied"));
        await load(true);
      } catch (e) {
        setOk(false);
        setStatus(e instanceof Error ? e.message : t("models.capSaveFailed"));
      }
    } catch {
      setOk(false);
      setStatus(t("models.networkError"));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  const setGlobalCap = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    void putCap({ value: Math.floor(value) });
  };

  const onSelectCap = (raw: string) => {
    if (raw === CUSTOM_OPTION) {
      setShowCustom(true);
      setCustomCap(String(contextCapValue));
      return;
    }
    setShowCustom(false);
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0 && value !== contextCapValue)
      setGlobalCap(value);
  };

  const applyCustomCap = () => {
    const value = Number(customCap.replace(/[_,\s]/g, ""));
    if (!Number.isFinite(value) || value <= 0) {
      setOk(false);
      setStatus(t("models.capSaveFailed"));
      return;
    }
    setShowCustom(false);
    setGlobalCap(value);
  };

  const allCapped = useMemo(() => {
    // Cap aggregate counts routed providers only; the single native group has no cap switch.
    const routed = groups.filter(
      (group) => !group.native && group.rows.length > 0,
    );
    return (
      routed.length > 0 &&
      routed.every((group) => contextCaps[group.provider] === contextCapValue)
    );
  }, [groups, contextCaps, contextCapValue]);
  const setAll = () => {
    void putCap({ setAll: !allCapped });
  };

  const fetchGroupModels = async (provider: string) => {
    if (fetchingProvider || busy) return;
    setFetchingProvider(provider);
    busyRef.current = true;
    setBusy(true);
    setStatus("");
    try {
      const result = await refreshProviderModels(apiBase, provider);
      await load(true);
      if (!result.ok) {
        setOk(false);
        setStatus(t("pws.fetchModelsFailed", { error: result.error }));
        return;
      }
      setOk(true);
      if (result.source === "static") {
        setStatus(t("pws.fetchModelsStatic", { count: result.count }));
      } else if (result.source === "passthrough") {
        setStatus(t("pws.fetchModelsPassthrough"));
      } else {
        setStatus(t("pws.fetchModelsOk", { count: result.count, provider }));
      }
    } catch {
      setOk(false);
      setStatus(t("models.networkError"));
    } finally {
      setFetchingProvider(null);
      busyRef.current = false;
      setBusy(false);
    }
  };

  const saveShadowCall = async (patch: Partial<ShadowCallData>) => {
    if (!shadowCall || shadowCallSaving) return;
    setShadowCallSaving(true);
    setShadowCall({ ...shadowCall, ...patch });
    try {
      await fetch(`${apiBase}/api/shadow-call-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } finally {
      setShadowCallSaving(false);
    }
  };

  const setMultiAgentMode = async (mode: "v1" | "default" | "v2") => {
    if (!v2 || v2BusyRef.current) return;
    if (v2.multiAgentMode === mode) return;
    setV2Busy(true);
    v2BusyRef.current = true;
    setV2Note("");
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ multiAgentMode: mode }),
      });
      try {
        const data = await readJsonOrThrow<V2Status & { warnings?: string[] }>(
          r,
          t("models.saveFailed"),
        );
        void loadV2();
        setOk(true);
        setStatus(t("models.v2Applied"));
        setV2Note((data?.warnings ?? []).join(" "));
      } catch (e) {
        setOk(false);
        setStatus(e instanceof Error ? e.message : t("models.saveFailed"));
      }
    } catch {
      setOk(false);
      setStatus(t("models.networkError"));
    } finally {
      setV2Busy(false);
      v2BusyRef.current = false;
    }
  };

  const putV2Threads = async (value: number) => {
    // Same guards as the flag toggle: single-flight + server-side idempotence
    // (setMaxConcurrentThreads no-ops on equal value), so a re-selected current
    // value or a double click can never double-write config.toml.
    if (!v2 || v2BusyRef.current) return;
    if (!Number.isInteger(value) || value < 1) {
      setOk(false);
      setStatus(t("models.v2ThreadsInvalid"));
      return;
    }
    if (v2.maxConcurrentThreadsPerSession === value) return;
    setV2Busy(true);
    v2BusyRef.current = true;
    setV2Note("");
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrentThreadsPerSession: value }),
      });
      try {
        const data = await readJsonOrThrow<V2Status & { warnings?: string[] }>(
          r,
          t("models.saveFailed"),
        );
        if (!data || typeof data.enabled !== "boolean") {
          setOk(false);
          setStatus(t("models.saveFailed"));
          return;
        }
        setV2({
          enabled: data.enabled,
          agentsMaxThreadsConflict: data.agentsMaxThreadsConflict === true,
          maxConcurrentThreadsPerSession:
            typeof data.maxConcurrentThreadsPerSession === "number"
              ? data.maxConcurrentThreadsPerSession
              : null,
          multiAgentMode:
            data.multiAgentMode === "v1" || data.multiAgentMode === "v2"
              ? data.multiAgentMode
              : "default",
        });
        setOk(true);
        setStatus(t("models.v2ThreadsApplied"));
        setShowThreadsCustom(false);
      } catch (e) {
        setOk(false);
        setStatus(e instanceof Error ? e.message : t("models.saveFailed"));
      }
    } catch {
      setOk(false);
      setStatus(t("models.networkError"));
    } finally {
      setV2Busy(false);
      v2BusyRef.current = false;
    }
  };

  const onSelectThreads = (raw: string) => {
    if (raw === CUSTOM_OPTION) {
      setShowThreadsCustom(true);
      setThreadsCustom(String(v2?.maxConcurrentThreadsPerSession ?? ""));
      return;
    }
    setShowThreadsCustom(false);
    void putV2Threads(Number(raw));
  };

  const addCustomModel = async (
    provider: string,
    modelId: string,
    displayName?: string,
    contextWindow?: number,
    inputModalities?: string[],
  ) => {
    setCustomSaving(true);
    setCustomError("");
    try {
      const r = await fetch(`${apiBase}/api/custom-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          modelId,
          displayName,
          contextWindow,
          inputModalities,
        }),
      });
      try {
        await readJsonOrThrow(r, t("models.customSaveFailed"));
        setCustomModalOpen(false);
        setOk(true);
        setStatus(t("models.customAdded"));
        await load(true);
      } catch (e) {
        setCustomError(
          e instanceof Error ? e.message : t("models.customSaveFailed"),
        );
      }
    } catch {
      setCustomError(t("models.networkError"));
    } finally {
      setCustomSaving(false);
    }
  };

  const updateCustomModel = async (
    id: string,
    patch: Record<string, unknown>,
  ) => {
    setCustomSaving(true);
    setCustomError("");
    try {
      const r = await fetch(
        `${apiBase}/api/custom-models/${encodeURIComponent(id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      try {
        await readJsonOrThrow(r, t("models.customSaveFailed"));
        setCustomModalOpen(false);
        setOk(true);
        setStatus(t("models.customUpdated"));
        await load(true);
      } catch (e) {
        setCustomError(
          e instanceof Error ? e.message : t("models.customSaveFailed"),
        );
      }
    } catch {
      setCustomError(t("models.networkError"));
    } finally {
      setCustomSaving(false);
    }
  };

  const deleteCustomModel = async (id: string) => {
    try {
      const r = await fetch(
        `${apiBase}/api/custom-models/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (r.ok) {
        setOk(true);
        setStatus(t("models.customDeleted"));
        await load(true);
      } else {
        setOk(false);
        setStatus(t("models.customSaveFailed"));
      }
    } catch {
      setOk(false);
      setStatus(t("models.networkError"));
    }
  };

  // Cold start only: with a session seed the workspace paints immediately and revalidates quietly.
  if (loading && !selectedModels) {
    return (
      <>
        <div className="models-control-top-row">
          <ModelsShadowControls
            shadowCall={shadowCall}
            shadowCallSaving={shadowCallSaving}
            shadowModelOptions={shadowModelOptions}
            saveShadowCall={saveShadowCall}
            setShadowCall={setShadowCall}
          />
        </div>
        <div className="row muted" role="status">
          <Spinner aria-hidden />
          {t("models.loading")}
        </div>
      </>
    );
  }
  if (!selectedModels) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("models.loadFail")}</AlertDescription>
      </Alert>
    );
  }

  const renderGroup = (group: ProviderModelGroup<ModelRow>) => (
    <ModelsProviderCard
      key={group.provider}
      group={group}
      selectedModels={selectedModels}
      disabled={disabled}
      catalogQuery={catalogQuery}
      collapsed={collapsed.has(group.provider)}
      capOn={contextCaps[group.provider] === contextCapValue}
      contextCapValue={contextCapValue}
      configured={providers.find((row) => row.name === group.provider)}
      shown={limit[group.provider] ?? PAGE}
      busy={busy}
      fetchingProvider={fetchingProvider}
      selectedModelName={selectedModelName}
      onSelectModel={(name, element) => {
        selectedRowRef.current = element;
        setSelectedModelName(name);
      }}
      onToggleVisibility={(model, enable) => {
        void applyVisibility(
          "models",
          group.provider,
          [{ id: model.id, native: model.native === true }],
          enable,
        );
      }}
      onBulkToggle={(rows, enable) => {
        void applyVisibility(
          "provider",
          group.provider,
          rows.map((model) => ({
            id: model.id,
            native: model.native === true,
          })),
          enable,
        );
      }}
      onToggleCollapse={() => toggleCollapse(group.provider)}
      onFetchModels={() => {
        void fetchGroupModels(group.provider);
      }}
      onAddCustom={() => {
        setCustomModalMode("add");
        setCustomModalProvider(group.provider);
        setCustomModalId("");
        setCustomFormModelId("");
        setCustomFormDisplayName("");
        setCustomFormContextWindow("");
        setCustomFormShowCustomCtx(false);
        setCustomFormModalities(["text"]);
        setCustomError("");
        setCustomModalOpen(true);
      }}
      onToggleCap={() => toggleProviderCap(group.provider)}
      onShowMore={() =>
        setLimit((prev) => ({
          ...prev,
          [group.provider]: (limit[group.provider] ?? PAGE) + PAGE,
        }))
      }
    />
  );

  const visibleGroups = selectedProvider
    ? groups.filter((group) => group.provider === selectedProvider)
    : groups;

  const controlsBlock = (
    <ModelsAdvancedControls
      shadowCall={shadowCall}
      shadowCallSaving={shadowCallSaving}
      shadowModelOptions={shadowModelOptions}
      saveShadowCall={saveShadowCall}
      setShadowCall={setShadowCall}
      v2={v2}
      v2Busy={v2Busy}
      setMultiAgentMode={setMultiAgentMode}
      setV2HelpOpen={setV2HelpOpen}
      v2Note={v2Note}
      showThreadsCustom={showThreadsCustom}
      threadsCustom={threadsCustom}
      setThreadsCustom={setThreadsCustom}
      onSelectThreads={onSelectThreads}
      putV2Threads={putV2Threads}
      contextCapValue={contextCapValue}
      showCustom={showCustom}
      customCap={customCap}
      setCustomCap={setCustomCap}
      busy={busy}
      onSelectCap={onSelectCap}
      applyCustomCap={applyCustomCap}
      allCapped={allCapped}
      setAll={setAll}
      models={models}
    />
  );

  const combosBlock = (
    <ModelsCombosSummary
      combos={combos}
      combosError={combosError}
      combosOpen={combosOpen}
      toggleCombosOpen={toggleCombosOpen}
    />
  );

  const collapseControls = (
    <ModelsCollapseControls
      busy={busy}
      catalogQuery={catalogQuery}
      setAllCollapsed={setAllCollapsed}
    />
  );

  const emptyStateBlock = <ModelsEmptyState groupCount={groups.length} />;

  const modalsBlock = (
    <ModelsModals
      v2HelpOpen={v2HelpOpen}
      setV2HelpOpen={setV2HelpOpen}
      customModalOpen={customModalOpen}
      setCustomModalOpen={setCustomModalOpen}
      customSaving={customSaving}
      customModalMode={customModalMode}
      customModalProvider={customModalProvider}
      customError={customError}
      customFormModelId={customFormModelId}
      setCustomFormModelId={setCustomFormModelId}
      customFormDisplayName={customFormDisplayName}
      setCustomFormDisplayName={setCustomFormDisplayName}
      customFormShowCustomCtx={customFormShowCustomCtx}
      setCustomFormShowCustomCtx={setCustomFormShowCustomCtx}
      customFormContextWindow={customFormContextWindow}
      setCustomFormContextWindow={setCustomFormContextWindow}
      customFormModalities={customFormModalities}
      setCustomFormModalities={setCustomFormModalities}
      onSaveCustom={() => {
        const modelId = customFormModelId.trim();
        const displayName = customFormDisplayName.trim();
        const ctxVal = customFormContextWindow
          ? Number(customFormContextWindow.replace(/[_,\s]/g, ""))
          : undefined;
        const contextWindow =
          ctxVal && ctxVal > 0 ? Math.floor(ctxVal) : undefined;
        if (customModalMode === "add") {
          void addCustomModel(
            customModalProvider,
            modelId,
            displayName || undefined,
            contextWindow,
            customFormModalities.length > 0 ? customFormModalities : undefined,
          );
        } else {
          void updateCustomModel(customModalId, {
            modelId,
            displayName,
            contextWindow: contextWindow ?? null,
            inputModalities: customFormModalities,
          });
        }
      }}
    />
  );

  const selectedModel = visibleGroups
    .flatMap((group) => group.rows)
    .find((model) => model.namespaced === selectedModelName);
  const selectedGroup = selectedModel
    ? groups.find((group) => group.provider === selectedModel.provider)
    : undefined;
  const query = catalogQuery.trim().toLowerCase();
  const hasMatches = visibleGroups.some((group) =>
    group.rows.some((model) =>
      `${model.id} ${model.displayName ?? ""} ${group.provider}`
        .toLowerCase()
        .includes(query),
    ),
  );
  const closeInspector = () => {
    setSelectedModelName(null);
    requestAnimationFrame(() => {
      if (
        selectedRowRef.current?.isConnected &&
        selectedRowRef.current.getClientRects().length
      )
        selectedRowRef.current.focus();
      else catalogSearchRef.current?.focus();
    });
  };

  return (
    <div className="models-workspace-shell">
      <div className="page-head">
        <div>
          <h2>{t("nav.models")}</h2>
          <p className="models-catalog-description">
            {t("models.workspace.description")}
          </p>
        </div>
        <Button
          variant="outline"
          nativeButton={false}
          render={
            <a
              href="#leveranciers"
              aria-label={t("models.workspace.manageProviders")}
            />
          }
          aria-label={t("models.workspace.manageProviders")}
        >
          {t("models.workspace.manageProviders")}
        </Button>
      </div>
      <ModelsStatus status={status} ok={ok} />
      <div className="models-catalog-toolbar">
        <InputGroup className="models-search-field">
          <InputGroupInput
            ref={catalogSearchRef}
            type="search"
            placeholder={t("models.workspace.search")}
            aria-label={t("models.workspace.search")}
            value={catalogQuery}
            onChange={(event) => {
              setCatalogQuery(event.target.value);
              setLimit({});
              setSelectedModelName(null);
            }}
          />
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          {catalogQuery && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-sm"
                aria-label={t("models.workspace.clearSearch")}
                onClick={() => {
                  setCatalogQuery("");
                  setLimit({});
                  catalogSearchRef.current?.focus();
                }}
              >
                <XIcon aria-hidden />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <LibrarySelect
          value={selectedProvider ?? ""}
          items={[
            { value: "", label: t("models.workspace.allProviders") },
            ...groups.map((group) => ({
              value: group.provider,
              label: group.provider,
            })),
          ]}
          onValueChange={(value) => {
            setSelectedProvider(value || null);
            setSelectedModelName(null);
          }}
        >
          <SelectTrigger
            aria-label={t("models.workspace.providers")}
            className="models-provider-filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} align="start">
            <SelectGroup>
              <SelectItem value="">
                {t("models.workspace.allProviders")}
              </SelectItem>
              {groups.map((group) => (
                <SelectItem key={group.provider} value={group.provider}>
                  {group.provider}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </LibrarySelect>
        <span className="models-catalog-count">
          {t("models.active", {
            active: effectiveVisibleCount,
            total: models.length,
          })}
        </span>
      </div>
      <div
        className={`models-workspace-root${selectedModel ? " has-selection" : ""}`}
      >
        <section
          className="models-workspace-main"
          aria-label={t("models.workspace.catalog")}
        >
          <div className="models-catalog-columns" aria-hidden="true">
            <span>{t("models.workspace.model")}</span>
            <span className="models-catalog-modalities-label">
              {t("models.tipModalities")}
            </span>
            <span>{t("models.tipContext")}</span>
            <span>{t("models.workspace.visibilityColumn")}</span>
          </div>
          <div className="models-provider-list">
            {visibleGroups.map(renderGroup)}
          </div>
          {query && !hasMatches && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>{t("models.workspace.noMatches")}</EmptyTitle>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  variant="ghost"
                  className=""
                  type="button"
                  onClick={() => {
                    setCatalogQuery("");
                    catalogSearchRef.current?.focus();
                  }}
                >
                  {t("models.workspace.clearSearch")}
                </Button>
              </EmptyContent>
            </Empty>
          )}
          {groups.length === 0 && emptyStateBlock}
          {collapseControls}
        </section>
        <ModelInspector
          model={selectedModel ?? null}
          group={selectedGroup}
          visible={selectedModelIsVisible(
            selectedModel,
            selectedModels,
            disabled,
          )}
          busy={busy || customSaving}
          onClose={closeInspector}
          onToggle={() => {
            if (selectedModel)
              void applyVisibility(
                "models",
                selectedModel.provider,
                [
                  {
                    id: selectedModel.id,
                    native: selectedModel.native === true,
                  },
                ],
                !modelVisible(
                  selectedModels,
                  selectedModel.provider,
                  selectedModel.id,
                  selectedModel.native === true,
                  disabled.has(selectedModel.namespaced),
                ),
              );
          }}
          onEdit={() => {
            if (!selectedModel?.customId) return;
            setCustomModalMode("edit");
            setCustomModalProvider(selectedModel.provider);
            setCustomModalId(selectedModel.customId);
            setCustomFormModelId(selectedModel.id);
            setCustomFormDisplayName(selectedModel.displayName ?? "");
            setCustomFormContextWindow(
              selectedModel.contextWindow
                ? String(selectedModel.contextWindow)
                : "",
            );
            setCustomFormShowCustomCtx(false);
            setCustomFormModalities(selectedModel.inputModalities ?? ["text"]);
            setCustomError("");
            setCustomModalOpen(true);
          }}
          onDelete={() => {
            if (
              selectedModel?.customId &&
              window.confirm(
                t("models.customDeleteConfirm", {
                  name: selectedModel.displayName ?? selectedModel.id,
                }),
              )
            ) {
              void deleteCustomModel(selectedModel.customId);
            }
          }}
        />
      </div>
      <Accordion className="models-advanced">
        <AccordionItem value="advanced">
          <AccordionTrigger>{t("models.workspace.advanced")}</AccordionTrigger>
          <AccordionContent>
            {controlsBlock}
            {combosBlock}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      {modalsBlock}
    </div>
  );
}

function ModelsCollapseControls({
  busy,
  catalogQuery,
  setAllCollapsed,
}: {
  busy: boolean;
  catalogQuery: string;
  setAllCollapsed: (collapse: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="row models-collapse-controls">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-caption"
        onClick={() => setAllCollapsed(true)}
        disabled={busy || catalogQuery.trim().length > 0}
      >
        <IconChevron width={13} height={13} aria-hidden="true" />{" "}
        {t("models.collapseAll")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-caption"
        onClick={() => setAllCollapsed(false)}
        disabled={busy || catalogQuery.trim().length > 0}
      >
        <IconChevron
          width={13}
          height={13}
          aria-hidden="true"
          style={{ transform: "rotate(90deg)" }}
        />{" "}
        {t("models.expandAll")}
      </Button>
    </div>
  );
}

function ModelsEmptyState({ groupCount }: { groupCount: number }) {
  const t = useT();
  return (
    <>
      {groupCount === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconBoxes aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{t("models.noRouted")}</EmptyTitle>
            <EmptyDescription>{t("models.noRoutedHint")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  );
}

function ModelsStatus({ status, ok }: { status: string; ok: boolean }) {
  return (
    <>
      {status && (
        <Alert
          variant={ok ? "default" : "destructive"}
          role={ok ? "status" : "alert"}
        >
          <AlertDescription>{status}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

function selectedModelIsVisible(
  model: ModelRow | undefined,
  selectedModels: ProviderModelMap,
  disabled: Set<string>,
): boolean {
  return model
    ? modelVisible(
        selectedModels,
        model.provider,
        model.id,
        model.native === true,
        disabled.has(model.namespaced),
      )
    : false;
}
