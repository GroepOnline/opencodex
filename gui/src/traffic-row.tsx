import type { ReactNode } from "react";
import { useI18n } from "./i18n/shared";
import { formatTokens } from "./format-tokens";
import { modelLabel } from "./model-display";
import {
  trafficPrincipalLabel,
  trafficProviderModelLabel,
  trafficStatusClass,
  trafficStatusLabel,
  type TrafficLogEntry,
} from "./traffic-shared";

/**
 * Renders the provider/model, principal, token count, duration, and status cells for a traffic entry.
 *
 * @param entry - The traffic entry to display
 * @param locale - The locale used to format localized values
 * @param tokens - The token count to display, when available
 */
export function TrafficRowCells({
  entry,
  locale,
  tokens,
}: {
  entry: TrafficLogEntry;
  locale: string;
  tokens?: number;
}) {
  const { t } = useI18n();
  const providerModel = trafficProviderModelLabel(entry);
  const principal = trafficPrincipalLabel(entry, t);
  const providerModelNode: ReactNode = providerModel
    ? modelLabel(providerModel)
    : t("vk.unknown");

  return (
    <>
      <span className="bon-col bon-col--model bon-titel" aria-label={t("vk.col.providerModel")}>{providerModelNode}</span>
      <span className="bon-col bon-col--principal bon-meta" aria-label={t("vk.col.principal")}>{principal}</span>
      <span className="bon-col bon-col--tokens bon-meta" aria-label={t("vk.col.tokens")}>
        {tokens !== undefined ? t("vk.rowTokens", { n: formatTokens(tokens, locale) }) : "\u2014"}
      </span>
      <span className="bon-col bon-col--duration bon-meta" aria-label={t("vk.col.duration")}>
        {t("vk.rowDuration", { s: (entry.durationMs / 1000).toFixed(1) })}
      </span>
      <span className={`bon-col bon-col--status stempel ${trafficStatusClass(entry)}`} aria-label={t("vk.col.status")}>
        {trafficStatusLabel(entry, t)}
      </span>
    </>
  );
}

/**
 * Renders localized column headings for the traffic table.
 */
export function TrafficColumnHead() {
  const { t } = useI18n();
  return (
    <div className="bon bon--head">
      <div className="bon-kop bon-kop--grid">
        <span className="bon-col bon-col--time">{t("vk.col.time")}</span>
        <span className="bon-col bon-col--model">{t("vk.col.providerModel")}</span>
        <span className="bon-col bon-col--principal">{t("vk.col.principal")}</span>
        <span className="bon-col bon-col--tokens">{t("vk.col.tokens")}</span>
        <span className="bon-col bon-col--duration">{t("vk.col.duration")}</span>
        <span className="bon-col bon-col--status">{t("vk.col.status")}</span>
      </div>
    </div>
  );
}
