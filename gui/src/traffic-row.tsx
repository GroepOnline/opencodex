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
      <span className="traffic-col traffic-col--model traffic-title">{providerModelNode}</span>
      <span className="traffic-col traffic-col--principal traffic-meta">{principal}</span>
      <span className="traffic-col traffic-col--tokens traffic-meta">
        {tokens !== undefined ? t("vk.rowTokens", { n: formatTokens(tokens, locale) }) : "\u2014"}
      </span>
      <span className="traffic-col traffic-col--duration traffic-meta">
        {t("vk.rowDuration", { s: (entry.durationMs / 1000).toFixed(1) })}
      </span>
      <span className={`traffic-col traffic-col--status traffic-status ${trafficStatusClass(entry)}`}>
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
    <div className="traffic-entry traffic-entry--head" aria-hidden="true">
      <div className="traffic-entry-head traffic-entry-head--grid">
        <span className="traffic-col traffic-col--time">{t("vk.col.time")}</span>
        <span className="traffic-col traffic-col--model">{t("vk.col.providerModel")}</span>
        <span className="traffic-col traffic-col--principal">{t("vk.col.principal")}</span>
        <span className="traffic-col traffic-col--tokens">{t("vk.col.tokens")}</span>
        <span className="traffic-col traffic-col--duration">{t("vk.col.duration")}</span>
        <span className="traffic-col traffic-col--status">{t("vk.col.status")}</span>
      </div>
    </div>
  );
}
