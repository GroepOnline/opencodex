import type { TFn } from "../../../i18n/shared";
import { Panel, PanelHeader } from "../../../components/primitives/panel";
import { Stat, StatGroup } from "../../../components/primitives/stat";
import type { UsageSummaryTotals } from "../model/usage-report";
export default function UsageCoveragePanel({
  summary,
  t,
}: {
  summary: UsageSummaryTotals;
  t: TFn;
}) {
  const sectionLabel = t("usage.section.coverage");
  const titleId = "usage-coverage-title";
  return (
    <Panel titleId={titleId} style={{ marginTop: 16 }}>
      <PanelHeader titleId={titleId} title={sectionLabel} />
      <StatGroup label={sectionLabel} className="usage-cards usage-cards-3x2">
        <Stat
          label={t("usage.coverage.measured")}
          value={summary.measuredRequests}
        />
        <Stat
          label={t("usage.coverage.reported")}
          value={summary.reportedRequests}
        />
        <Stat
          label={t("usage.coverage.estimated")}
          value={summary.estimatedRequests}
        />
        <Stat
          label={t("logs.tokens.unreported")}
          value={summary.unreportedRequests}
        />
        <Stat
          label={t("logs.tokens.unsupported")}
          value={summary.unsupportedRequests}
        />
      </StatGroup>
      <p className="muted text-control" style={{ marginTop: 12 }}>
        {t("usage.coverage.note")}
      </p>
    </Panel>
  );
}
