import { BarChart3 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/shared";
import { Notice } from "../ui";
import { PageHeader } from "../components/primitives/page-header";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/primitives/empty";
import { Spinner } from "../components/primitives/spinner";
import { buildHeatmap, lastSevenDays, usagePayloadKey, type Range, type UsageResponse, type UsageSurface } from "../features/usage/model/usage-report";
import UsageFilters from "../features/usage/components/UsageFilters";
import UsageSummaryCards from "../features/usage/components/UsageSummaryCards";
import UsageQualityPanel from "../features/usage/components/UsageQualityPanel";
import UsageHeatmapPanel from "../features/usage/components/UsageHeatmapPanel";
import UsageModelsTable from "../features/usage/components/UsageModelsTable";
import UsageProvidersTable from "../features/usage/components/UsageProvidersTable";
import UsageCoveragePanel from "../features/usage/components/UsageCoveragePanel";

export default function Usage({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [range, setRange] = useState<Range>("30d");
  const [surface, setSurface] = useState<UsageSurface>("all");
  const [snapshot, setSnapshot] = useState<{
    key: string;
    data: UsageResponse;
  } | null>(null);
  const data =
    snapshot?.key === usagePayloadKey(apiBase, range, surface)
      ? snapshot.data
      : null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const loadGenerationRef = useRef(0);
  const dataRef = useRef<UsageResponse | null>(null);
  const lastGoodKeyRef = useRef<string | null>(null);

  const fetchUsage = useCallback(
    async (
      nextRange: Range,
      nextSurface: UsageSurface,
      signal: AbortSignal,
    ) => {
      const generation = ++loadGenerationRef.current;
      const requestKey = usagePayloadKey(apiBase, nextRange, nextSurface);
      setLoading(true);
      try {
        const res = await fetch(
          `${apiBase}/api/usage?range=${nextRange}&surface=${nextSurface}`,
          { signal },
        );
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
        const json = (await res.json()) as UsageResponse;
        if (signal.aborted || generation !== loadGenerationRef.current) return;
        lastGoodKeyRef.current = requestKey;
        dataRef.current = json;
        setSnapshot({ key: requestKey, data: json });
        setError(null);
      } catch (cause) {
        // A stale request (range/apiBase changed, or unmount) must not overwrite newer state.
        if (signal.aborted || generation !== loadGenerationRef.current) return;
        // Keep last-good readings only for this API, range and surface.
        if (lastGoodKeyRef.current !== requestKey || !dataRef.current) {
          dataRef.current = null;
          setSnapshot(null);
        }
        const detail = cause instanceof Error ? cause.message : "";
        setError(
          detail ? `${t("usage.loadError")} ${detail}` : t("usage.loadError"),
        );
      } finally {
        // Only the current request may clear loading — a superseded abort must not
        // settle the UI while a newer fetch is still in flight.
        if (generation === loadGenerationRef.current) setLoading(false);
      }
    },
    [apiBase, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    const run = () => {
      void fetchUsage(range, surface, controller.signal);
    };
    const timeout = window.setTimeout(run, 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      run();
    }, 30_000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      // Invalidate before abort so a superseded request's finally cannot clear
      // loading in the gap before the deferred replacement increments generation.
      loadGenerationRef.current += 1;
      controller.abort();
    };
  }, [fetchUsage, range, surface]);

  const heatmap = useMemo(() => buildHeatmap(data?.days ?? []), [data?.days]);
  const weekBars = useMemo(() => lastSevenDays(data?.days ?? []), [data?.days]);
  const activeDays = useMemo(
    () => (data?.days ?? []).filter((d) => d.requests > 0).length,
    [data?.days],
  );
  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const models = data?.models ?? [];
    const sorted = models.toSorted((a, b) => b.totalTokens - a.totalTokens);
    if (!q) return sorted.slice(0, 100);
    return sorted
      .filter(
        (m) =>
          m.model.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q) ||
          (m.resolvedModel ?? "").toLowerCase().includes(q),
      )
      .slice(0, 100);
  }, [data?.models, modelQuery]);

  const sortedProviders = useMemo(
    () =>
      (data?.providers ?? []).toSorted((a, b) => b.totalTokens - a.totalTokens),
    [data?.providers],
  );

  return (
    <div className="usage-page ocx-page-root">
      <PageHeader
        titleId="usage-page-title"
        className="usage-head"
        title={t("usage.title")}
        description={t("usage.subtitle")}
        actions={
          <UsageFilters
            surface={surface}
            range={range}
            onSurface={setSurface}
            onRange={setRange}
            t={t}
          />
        }
      />

      {error ? (
        <Notice tone="err">
          {error}{" "}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() =>
              void fetchUsage(range, surface, new AbortController().signal)
            }
            disabled={loading}
          >
            {t("common.retry")}
          </button>
        </Notice>
      ) : null}
      {loading && !data ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Spinner />
            </EmptyMedia>
            <EmptyTitle>{t("usage.loading")}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : data?.summary.requests === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BarChart3 aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{t("usage.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("usage.empty")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : data ? (
        <>
          <UsageSummaryCards
            summary={data.summary}
            activeDays={activeDays}
            locale={locale}
            t={t}
          />
          <UsageQualityPanel summary={data.summary} t={t} />
          <UsageHeatmapPanel
            range={range}
            heatmap={heatmap}
            weekBars={weekBars}
            locale={locale}
            t={t}
          />
          <UsageModelsTable
            models={filteredModels}
            modelQuery={modelQuery}
            onModelQuery={setModelQuery}
            locale={locale}
            t={t}
          />
          <UsageProvidersTable
            providers={sortedProviders}
            locale={locale}
            t={t}
          />
          <UsageCoveragePanel summary={data.summary} t={t} />
        </>
      ) : null}
    </div>
  );
}
