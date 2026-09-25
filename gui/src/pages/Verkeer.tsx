import { useMemo, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { Notice } from "../ui";
import { Spinner } from "../components/primitives/spinner";
import { Activity } from "lucide-react";
import { formatTokens } from "../format-tokens";
import { formatPercent, formatUsd } from "../intl-formatters";
import { useI18n, type Locale, type TFn } from "../i18n/shared";
import { IconChevron } from "../icons";
import { KeyPoolHealthPanel, ResponseCachePanel } from "../ops-panels";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/primitives/empty";
import { PageHeader } from "../components/primitives/page-header";
import { Panel, PanelHeader } from "../components/primitives/panel";
import {
  CollapsibleGroup,
  CollapsibleGroupHead,
  CollapsibleGroupName,
  CollapsibleGroupToggle,
} from "../components/primitives/collapsible-group";
import {
  SegmentedControl,
  SegmentedOption,
} from "../components/primitives/segmented-control";
import { StatStrip, StatStripItem } from "../components/primitives/stat-strip";
import { Timestamp } from "../components/primitives/timestamp";
import { TrafficColumnHead, TrafficRowCells } from "../traffic-row";
import {
  requestsTodayCount,
  trafficPrincipalLabel,
  trafficProviderModelLabel,
  type TrafficLogEntry,
} from "../traffic-shared";
import Usage from "./Usage";

interface UsageSummary {
  summary: {
    requests: number;
    totalTokens: number;
    estimatedCostUsd?: number;
    cacheReadRatio?: number;
    p95LatencyMs?: number;
    ratio429?: number;
    ratio502?: number;
  };
  providers?: Array<{
    provider: string;
    requests: number;
    totalTokens: number;
    estimatedCostUsd?: number;
    cacheReadRatio?: number;
  }>;
  models?: Array<{
    provider: string;
    model: string;
    requests: number;
    totalTokens: number;
    inputTokens?: number;
    outputTokens?: number;
    shareRatio?: number;
    estimatedCostUsd?: number;
  }>;
  days: Array<{ date: string; requests: number; totalTokens?: number }>;
}

/** Soft poll — CF edge used to 1015 at 100/min on /api/*; keep headroom for other tabs. */
const TAIL_INTERVAL_MS = 12_000;

/**
 * Determines the total token count for a traffic log entry.
 *
 * @param entry - The traffic log entry to inspect
 * @returns The total token count, or `undefined` when unavailable
 */
function bonTokens(entry: TrafficLogEntry): number | undefined {
  if (entry.usage)
    return (
      entry.usage.totalTokens ??
      entry.usage.inputTokens + entry.usage.outputTokens
    );
  return entry.totalTokens;
}

type UsageProviderRow = NonNullable<UsageSummary["providers"]>[number];
type UsageModelRow = NonNullable<UsageSummary["models"]>[number];

function dashUsd(
  value: number | undefined,
  locale: Locale,
  unavailable: string,
): string {
  return typeof value === "number" && Number.isFinite(value)
    ? formatUsd(value, locale)
    : unavailable;
}

function dashPct(
  value: number | undefined,
  locale: Locale,
  unavailable: string,
): string {
  return typeof value === "number" && Number.isFinite(value)
    ? formatPercent(value, locale)
    : unavailable;
}

function TrafficStatsStrip({
  tokens30d,
  requestsVandaag,
  requests30d,
  cacheReadRatio,
  proxyCacheRatio,
  estimatedCostUsd,
  p95LatencyMs,
  ratio429,
  locale,
  t,
}: {
  tokens30d: number | undefined;
  requestsVandaag: number | undefined;
  requests30d: number | undefined;
  cacheReadRatio: number | undefined;
  proxyCacheRatio: number | null;
  estimatedCostUsd: number | undefined;
  p95LatencyMs: number | undefined;
  ratio429: number | undefined;
  locale: Locale;
  t: TFn;
}) {
  const unavailable = t("common.unavailable");
  return (
    <StatStrip label={t("vk.statsAria")}>
      <StatStripItem
        label={t("vk.tokens30d")}
        value={
          tokens30d === undefined
            ? unavailable
            : formatTokens(tokens30d, locale)
        }
      />
      <StatStripItem
        label={t("vk.requestsToday")}
        value={
          requestsVandaag === undefined
            ? unavailable
            : requestsVandaag.toLocaleString(locale)
        }
      />
      <StatStripItem
        label={t("vk.requests30d")}
        value={
          requests30d === undefined
            ? unavailable
            : requests30d.toLocaleString(locale)
        }
      />
      <StatStripItem
        label={t("vk.cacheHit")}
        value={dashPct(cacheReadRatio, locale, unavailable)}
      />
      <StatStripItem
        label={t("vk.proxyCacheHit")}
        value={dashPct(proxyCacheRatio ?? undefined, locale, unavailable)}
      />
      <StatStripItem
        label={t("vk.costUsd")}
        value={dashUsd(estimatedCostUsd, locale, unavailable)}
      />
      <StatStripItem
        label={t("vk.p95")}
        value={
          typeof p95LatencyMs === "number" && p95LatencyMs > 0
            ? `${(p95LatencyMs / 1000).toLocaleString(locale, {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              })}${t("vk.p95Unit")}`
            : unavailable
        }
      />
      <StatStripItem
        label={t("vk.ratio429")}
        value={dashPct(ratio429, locale, unavailable)}
      />
    </StatStrip>
  );
}

function ProviderShareTable({
  providers,
  locale,
  t,
}: {
  providers: UsageProviderRow[];
  locale: Locale;
  t: TFn;
}) {
  const titleId = "vk-provider-table-title";
  return (
    <Panel titleId={titleId} style={{ marginTop: 16 }}>
      <PanelHeader titleId={titleId} title={t("vk.providerTableHead")} />
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t("vk.providerColProvider")}</th>
              <th className="num">{t("vk.providerColRequests")}</th>
              <th className="num">{t("vk.providerColTokens")}</th>
              <th className="num">{t("vk.providerColCost")}</th>
              <th className="num">{t("vk.providerColCache")}</th>
            </tr>
          </thead>
          <tbody>
            {providers
              .slice()
              .sort((a, b) => b.requests - a.requests)
              .map((provider) => (
                <tr key={provider.provider}>
                  <td className="mono">{provider.provider}</td>
                  <td className="num">
                    {provider.requests.toLocaleString(locale)}
                  </td>
                  <td className="num">
                    {formatTokens(provider.totalTokens, locale)}
                  </td>
                  <td className="num">
                    {dashUsd(
                      provider.estimatedCostUsd,
                      locale,
                      t("common.unavailable"),
                    )}
                  </td>
                  <td className="num">
                    {dashPct(
                      provider.cacheReadRatio,
                      locale,
                      t("common.unavailable"),
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ModelShareTable({
  models,
  locale,
  t,
}: {
  models: UsageModelRow[];
  locale: Locale;
  t: TFn;
}) {
  const titleId = "vk-model-table-title";
  return (
    <Panel titleId={titleId} style={{ marginTop: 16 }}>
      <PanelHeader titleId={titleId} title={t("vk.modelTableHead")} />
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t("vk.modelColModel")}</th>
              <th className="num">{t("vk.modelColRequests")}</th>
              <th className="num">{t("vk.modelColTokens")}</th>
              <th className="num">{t("vk.modelColShare")}</th>
              <th className="num">{t("vk.modelColCost")}</th>
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <tr key={`${model.provider}/${model.model}`}>
                <td className="mono">
                  {model.model}
                  {model.provider ? (
                    <span className="muted"> · {model.provider}</span>
                  ) : null}
                </td>
                <td className="num">{model.requests.toLocaleString(locale)}</td>
                <td className="num">
                  {formatTokens(model.totalTokens, locale)}
                </td>
                <td className="num">
                  {dashPct(model.shareRatio, locale, t("common.unavailable"))}
                </td>
                <td className="num">
                  {dashUsd(
                    model.estimatedCostUsd,
                    locale,
                    t("common.unavailable"),
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function TrafficProviderFilters({
  providers,
  providerFilter,
  paused,
  onFilter,
  onTogglePaused,
  t,
}: {
  providers: string[];
  providerFilter: string | null;
  paused: boolean;
  onFilter: (provider: string | null) => void;
  onTogglePaused: () => void;
  t: TFn;
}) {
  return (
    <div className="verkeer-filters">
      <SegmentedControl label={t("vk.filterAria")}>
        <SegmentedOption
          pressed={providerFilter === null}
          label={t("vk.all")}
          className={`usage-segmented-btn${providerFilter === null ? " active" : ""}`}
          onClick={() => onFilter(null)}
        >
          {t("vk.all")}
        </SegmentedOption>
        {providers.map((provider) => (
          <SegmentedOption
            key={provider}
            pressed={providerFilter === provider}
            label={provider}
            className={`usage-segmented-btn${providerFilter === provider ? " active" : ""}`}
            onClick={() =>
              onFilter(providerFilter === provider ? null : provider)
            }
          >
            {provider}
          </SegmentedOption>
        ))}
      </SegmentedControl>
      <button
        type="button"
        className="btn btn-ghost btn-sm verkeer-filters__pause"
        onClick={onTogglePaused}
        aria-pressed={paused}
      >
        {paused ? t("vk.follow") : t("vk.pause")}
      </button>
    </div>
  );
}

/**
 * Displays traffic statistics, recent requests, provider filters, and optional usage analysis.
 *
 * @param apiBase - The base URL for API requests.
 */
export default function Verkeer({ apiBase }: { apiBase: string }) {
  const { locale, t } = useI18n();
  const summaryPoll = useKeyedClientResource(
    `traffic-summary:${apiBase}`,
    [],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/usage?range=30d`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as UsageSummary;
    },
    { pollMs: 60_000 },
  );
  const summary30d = summaryPoll.data;
  const cachePoll = useKeyedClientResource(
    `traffic-cache:${apiBase}`,
    [],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/response-cache`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        enabled?: boolean;
        stats?: { hits: number; misses: number };
      };
      const hits = data.stats?.hits ?? 0;
      const lookups = hits + (data.stats?.misses ?? 0);
      return data.enabled && lookups > 0 ? hits / lookups : null;
    },
    { pollMs: 15_000 },
  );
  const proxyCacheRatio = cachePoll.data ?? null;
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [openBon, setOpenBon] = useState<string | null>(null);
  const [analyseOpen, setAnalyseOpen] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);
  const logsPoll = useKeyedClientResource(
    `traffic-logs:${apiBase}`,
    [],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/logs`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as TrafficLogEntry[];
      return Array.isArray(data)
        ? data.toSorted((a, b) => b.timestamp - a.timestamp)
        : [];
    },
    { pollMs: TAIL_INTERVAL_MS, enabled: !paused },
  );
  const logs = useMemo(() => logsPoll.data ?? [], [logsPoll.data]);
  const logsFailed = logsPoll.error !== undefined;

  const providers = useMemo(() => {
    const names = new Set<string>();
    for (const entry of logs) {
      const principal = trafficPrincipalLabel(entry, t);
      if (principal !== t("vk.unknown")) names.add(principal);
      const providerModel = trafficProviderModelLabel(entry);
      if (providerModel?.includes("/")) names.add(providerModel.split("/")[0]!);
    }
    return [...names].sort();
  }, [logs, t]);

  const zichtbaar = useMemo(() => {
    const rows = providerFilter
      ? logs.filter((entry) => {
          const principal = trafficPrincipalLabel(entry, t);
          const providerModel = trafficProviderModelLabel(entry) ?? "";
          return (
            principal === providerFilter ||
            entry.provider === providerFilter ||
            providerModel.startsWith(`${providerFilter}/`)
          );
        })
      : logs;
    return rows.slice(0, 60);
  }, [logs, providerFilter, t]);

  const requestsVandaag = useMemo(
    () => requestsTodayCount(logs, summary30d?.days),
    [logs, summary30d],
  );

  const requests30d = summary30d?.summary.requests;
  const tokens30d = summary30d?.summary.totalTokens;

  /** Per-model breakdown (top 12 by requests, 30d from /api/usage models[]). */
  const topModellen = useMemo(() => {
    const ms = summary30d?.models ?? [];
    return ms.toSorted((a, b) => b.requests - a.requests).slice(0, 12);
  }, [summary30d]);

  return (
    <div className="verkeer-page ocx-page-root">
      <PageHeader
        title={t("shell.navTraffic")}
        description={t("vk.subtitle")}
      />

      <TrafficStatsStrip
        tokens30d={tokens30d}
        requestsVandaag={
          summary30d || logsPoll.data !== undefined
            ? requestsVandaag
            : undefined
        }
        requests30d={requests30d}
        cacheReadRatio={summary30d?.summary.cacheReadRatio}
        proxyCacheRatio={proxyCacheRatio}
        estimatedCostUsd={summary30d?.summary.estimatedCostUsd}
        p95LatencyMs={summary30d?.summary.p95LatencyMs}
        ratio429={summary30d?.summary.ratio429}
        locale={locale}
        t={t}
      />

      {summaryPoll.loading && summaryPoll.data === undefined && (
        <p role="status" className="muted text-caption">
          {t("usage.loading")}
        </p>
      )}
      {summaryPoll.error !== undefined && (
        <Notice tone="err">
          {t("usage.loadError")}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={summaryPoll.loading}
            onClick={() => summaryPoll.refresh({ forceLoading: true })}
          >
            {t("common.retry")}
          </button>
        </Notice>
      )}
      {cachePoll.loading && cachePoll.data === undefined && (
        <p role="status" className="muted text-caption">
          {t("ops.cacheHead")}: {t("common.loading")}
        </p>
      )}
      {cachePoll.error !== undefined && (
        <Notice tone="err">
          {t("ops.cacheFailed")}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={cachePoll.loading}
            onClick={() => cachePoll.refresh({ forceLoading: true })}
          >
            {t("common.retry")}
          </button>
        </Notice>
      )}

      {summary30d?.providers && summary30d.providers.length > 0 ? (
        <ProviderShareTable
          providers={summary30d.providers}
          locale={locale}
          t={t}
        />
      ) : null}

      {topModellen.length > 0 ? (
        <ModelShareTable models={topModellen} locale={locale} t={t} />
      ) : null}

      <TrafficProviderFilters
        providers={providers}
        providerFilter={providerFilter}
        paused={paused}
        onFilter={setProviderFilter}
        onTogglePaused={() => setPaused((current) => !current)}
        t={t}
      />

      {logsFailed ? (
        <p
          className="text-caption"
          style={{ color: "var(--red)" }}
          role="status"
        >
          {t("vk.loadFailed")}
        </p>
      ) : null}

      <TrafficColumnHead />

      <div
        className="rail ocx-reveal-list"
        aria-live="polite"
        onFocus={() => setPaused(true)}
      >
        {logsPoll.data === undefined ? (
          !logsFailed ? (
            <Empty role="status">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Spinner />
                </EmptyMedia>
                <EmptyTitle>{t("common.loading")}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : null
        ) : zichtbaar.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Activity aria-hidden />
              </EmptyMedia>
              <EmptyTitle>{t("vk.emptyTitle")}</EmptyTitle>
              <EmptyDescription>{t("vk.emptyDesc")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          zichtbaar.map((entry) => {
            const id =
              entry.requestId ??
              `${entry.timestamp}-${entry.provider}-${entry.model}`;
            const tokens = bonTokens(entry);
            const isOpen = openBon === id;
            return (
              <div key={id} className="traffic-entry">
                <button
                  type="button"
                  className="traffic-entry-head traffic-entry-head--grid traffic-entry-head--button"
                  onClick={() =>
                    setOpenBon((current) => (current === id ? null : id))
                  }
                  aria-expanded={isOpen}
                >
                  <Timestamp
                    value={entry.timestamp}
                    locale={locale}
                    className="traffic-col traffic-col--time traffic-time"
                  />
                  <TrafficRowCells
                    entry={entry}
                    locale={locale}
                    tokens={tokens}
                  />
                </button>
                {isOpen ? (
                  <div className="traffic-detail">
                    <div>{t("vk.detailStatus", { status: entry.status })}</div>
                    {entry.errorCode ? (
                      <div>
                        {t("vk.detailError", { code: entry.errorCode })}
                      </div>
                    ) : null}
                    {entry.upstreamError ? (
                      <div>
                        {t("vk.detailUpstream", { error: entry.upstreamError })}
                      </div>
                    ) : null}
                    {entry.usage ? (
                      <div>
                        {t("vk.detailInOut", {
                          in: entry.usage.inputTokens,
                          out: entry.usage.outputTokens,
                        })}
                      </div>
                    ) : null}
                    {entry.requestId ? (
                      <div>{t("vk.detailId", { id: entry.requestId })}</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <CollapsibleGroup
        collapsed={!opsOpen}
        labelledBy="vk-ops-title"
        className="verkeer-disclosure"
      >
        <CollapsibleGroupHead collapsed={!opsOpen}>
          <CollapsibleGroupToggle
            titleId="vk-ops-title"
            controls="vk-ops-body"
            expanded={opsOpen}
            onClick={() => setOpsOpen((open) => !open)}
          >
            <IconChevron
              className="ocx-chevron"
              width={15}
              height={15}
              aria-hidden="true"
            />
            <CollapsibleGroupName>{t("vk.showOps")}</CollapsibleGroupName>
          </CollapsibleGroupToggle>
        </CollapsibleGroupHead>
        {opsOpen ? (
          <div id="vk-ops-body" className="ocx-group-body">
            <Panel titleId="ops-cache-title">
              <PanelHeader
                titleId="ops-cache-title"
                title={t("ops.cacheHead")}
              />
              <ResponseCachePanel apiBase={apiBase} />
            </Panel>
            <Panel titleId="ops-pool-title">
              <PanelHeader titleId="ops-pool-title" title={t("ops.poolHead")} />
              <KeyPoolHealthPanel apiBase={apiBase} />
            </Panel>
          </div>
        ) : null}
      </CollapsibleGroup>

      <CollapsibleGroup
        collapsed={!analyseOpen}
        labelledBy="vk-analyse-title"
        className="verkeer-disclosure"
      >
        <CollapsibleGroupHead collapsed={!analyseOpen}>
          <CollapsibleGroupToggle
            titleId="vk-analyse-title"
            controls="vk-analyse-body"
            expanded={analyseOpen}
            onClick={() => setAnalyseOpen((open) => !open)}
          >
            <IconChevron
              className="ocx-chevron"
              width={15}
              height={15}
              aria-hidden="true"
            />
            <CollapsibleGroupName>{t("vk.showAnalysis")}</CollapsibleGroupName>
          </CollapsibleGroupToggle>
        </CollapsibleGroupHead>
        {analyseOpen ? (
          <div id="vk-analyse-body" className="ocx-group-body">
            <Panel titleId="vk-analyse-panel">
              <Usage apiBase={apiBase} />
            </Panel>
          </div>
        ) : null}
      </CollapsibleGroup>
    </div>
  );
}
