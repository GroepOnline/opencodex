import type { Locale, TFn } from "../../../i18n/shared";
import { formatTokens } from "../../../format-tokens";
import { formatEstimatedUsdValue as formatUsdEstimate } from "../../../intl-formatters";
import { Panel, PanelHeader } from "../../../components/primitives/panel";
import { Stat, StatGroup } from "../../../components/primitives/stat";
import { formatPct, type UsageSummaryTotals } from "../model/usage-report";
export default function UsageSummaryCards({
  summary,
  activeDays,
  locale,
  t,
}: {
  summary: UsageSummaryTotals;
  activeDays: number;
  locale: Locale;
  t: TFn;
}) {
  const titleId = "usage-proxy-title";
  const sectionLabel = t("usage.section.proxyUsage");
  return (
    <Panel titleId={titleId} style={{ marginTop: 0 }}>
      <PanelHeader titleId={titleId} title={sectionLabel} />
      <StatGroup label={sectionLabel} className="usage-cards usage-cards-3x2">
        <Stat label={t("usage.card.requests")} value={summary.requests} />
        <Stat
          label={t("usage.card.measured")}
          value={summary.measuredRequests}
        />
        <Stat
          label={t("usage.card.totalTokens")}
          value={formatTokens(summary.totalTokens, locale)}
        />
        <Stat
          title={t("usage.card.cachedTokensHint")}
          label={t("usage.card.cachedTokens")}
          value={formatTokens(
            summary.cacheReadInputTokens ?? summary.cachedInputTokens,
            locale,
          )}
          hint={
            (summary.cacheCreationInputTokens ?? 0) > 0 ? (
              <div className="muted text-caption">
                {t("usage.card.cacheWriteTokens")}:{" "}
                {formatTokens(summary.cacheCreationInputTokens ?? 0, locale)}
              </div>
            ) : null
          }
        />
        <Stat
          label={t("usage.card.coverage")}
          value={formatPct(summary.coverageRatio)}
        />
        <Stat label={t("usage.card.activeDays")} value={activeDays} />
      </StatGroup>
      {summary.estimatedCostUsd !== undefined && (
        <div className="usage-cost-row" role="note">
          <span className="muted">{t("usage.cost.total")}</span>
          <span className="stat-value mono usage-cost-value">
            {formatUsdEstimate(summary.estimatedCostUsd, locale)}
          </span>
          <span className="muted text-caption">
            {t("usage.cost.disclaimer")}
          </span>
          {(summary.unpricedRequests ?? 0) + (summary.unmeteredRequests ?? 0) >
            0 && (
            <span className="muted text-caption">
              {t("usage.cost.unpricedNote").replace(
                "{count}",
                String(
                  (summary.unpricedRequests ?? 0) +
                    (summary.unmeteredRequests ?? 0),
                ),
              )}
            </span>
          )}
        </div>
      )}
    </Panel>
  );
}
