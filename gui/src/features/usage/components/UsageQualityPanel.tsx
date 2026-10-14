import type { TFn } from "../../../i18n/shared";
import { Panel, PanelHeader } from "../../../components/primitives/panel";
import { Stat, StatGroup } from "../../../components/primitives/stat";
import { formatPct, type UsageSummaryTotals } from "../model/usage-report";
export default function UsageQualityPanel({
  summary,
  t,
}: {
  summary: UsageSummaryTotals;
  t: TFn;
}) {
  const titleId = "usage-quality-title";
  const sectionLabel = t("usage.section.quality");
  return (
    <Panel titleId={titleId} style={{ marginTop: 16 }}>
      <PanelHeader titleId={titleId} title={sectionLabel} />
      <StatGroup label={sectionLabel} className="usage-cards usage-cards-3x2">
        <Stat
          label={t("usage.quality.p95Latency")}
          value={
            summary.p95LatencyMs !== undefined && summary.latencySampleCount !== 0
              ? `${summary.p95LatencyMs}ms`
              : "\u2014"
          }
          valueClassName="stat-value mono"
        />
        <Stat
          label={t("usage.quality.p95Ttft")}
          value={
            summary.p95TtftMs !== undefined && summary.ttftSampleCount !== 0
              ? `${summary.p95TtftMs}ms`
              : "\u2014"
          }
          valueClassName="stat-value mono"
        />
        <Stat
          label={t("usage.quality.cacheReadRatio")}
          value={summary.cacheReadRatio === undefined || summary.inputTokens === 0 ? "—" : formatPct(summary.cacheReadRatio)}
        />
        <Stat
          label={t("usage.quality.ratio429")}
          value={summary.ratio429 === undefined ? "—" : formatPct(summary.ratio429)}
        />
        <Stat
          label={t("usage.quality.ratio502")}
          value={summary.ratio502 === undefined ? "—" : formatPct(summary.ratio502)}
        />
      </StatGroup>
      <p className="muted text-control" style={{ marginTop: 12 }}>
        {t("usage.quality.note")}
      </p>
    </Panel>
  );
}
