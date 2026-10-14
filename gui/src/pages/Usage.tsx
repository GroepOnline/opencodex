import { BarChart3 } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../i18n/shared";
import { Notice } from "../ui";
import { PageHeader } from "../components/primitives/page-header";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/primitives/empty";
import { Spinner } from "../components/primitives/spinner";
import { buildHeatmap, lastSevenDays, type Range, type UsageSurface } from "../features/usage/model/usage-report";
import { useUsageData } from "../features/usage/hooks/useUsageData";
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
  const [modelQuery, setModelQuery] = useState("");
  const { data, loading, error, retry } = useUsageData({ apiBase, range, surface, t });
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
            onClick={retry}
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
