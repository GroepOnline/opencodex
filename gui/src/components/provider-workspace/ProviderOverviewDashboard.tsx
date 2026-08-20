/**
 * ProviderOverviewDashboard — operate view: who may take the next attempt.
 */
import { useMemo } from "react";
import { useT, useI18n } from "../../i18n/shared";
import { IconAlert, IconCheck, IconChevron, IconClock, IconX } from "../../icons";
import type { WorkspaceSections, WorkspaceItem } from "../../provider-workspace/catalog";
import { providerAvailabilityLine } from "../../provider-workspace/catalog";
import { accountQuotaFromReport, type ProviderQuotaReportView } from "../../provider-workspace/report";
import {
  attentionReasonKey,
  buildAttentionItems,
  buildMostUsedProviders,
  formatRequestCount,
  type ProviderUsageTotals,
} from "../../provider-workspace/usage";
import { maxQuotaUtilisation, formatResetFuture } from "../QuotaBars";
import { ProviderIcon } from "./ProviderRail";
import { formatProviderDisplayName } from "../../provider-icons";
import QuotaBars from "../QuotaBars";
import type { QuotaCardState } from "./use-provider-quotas";
import type { AvailabilityProviderView, ProviderCapCooldown } from "../../pages/providers-shared";

/** HH:MM (mono) for the VERS · HH:MM / VEROUDERD · HH:MM stamps. */
function clockTime(epoch: number): string {
  const d = new Date(epoch);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function StatusMark({ tone }: { tone: "ready" | "warn" | "cool" | "off" }) {
  if (tone === "ready") return <IconCheck size={13} aria-hidden="true" />;
  if (tone === "cool") return <IconClock size={13} aria-hidden="true" />;
  if (tone === "off") return <IconX size={13} aria-hidden="true" />;
  return <IconAlert size={13} aria-hidden="true" />;
}

/**
 * Renders an aggregate dashboard for configured providers, quotas, usage, and provider attention states.
 *
 * @param sections - Provider groups categorized by readiness and disabled status
 * @param quotaCards - Per-provider quota loading, error, and report states
 * @param usageTotals - Per-provider request totals used for recently used providers
 * @param providerCooldowns - Optional provider cooldowns and reset timestamps
 * @param usageLoading - Whether usage data is loading
 * @param quotasLoading - Whether quota data is loading
 * @param onSelectProvider - Handles navigation to a provider
 * @param onRefreshQuota - Retries loading quota data for a provider
 * @param onEditConfig - Optionally opens the provider configuration editor
 * @returns The provider overview dashboard
 */
export default function ProviderOverviewDashboard({
  sections,
  quotaCards,
  usageTotals,
  providerCooldowns,
  availability,
  usageLoading = false,
  quotasLoading = false,
  onSelectProvider,
  onRefreshQuota,
  onEditConfig,
}: {
  sections: WorkspaceSections;
  quotaCards: Record<string, QuotaCardState>;
  usageTotals: Record<string, ProviderUsageTotals>;
  providerCooldowns?: Record<string, ProviderCapCooldown>;
  availability?: AvailabilityProviderView[];
  usageLoading?: boolean;
  quotasLoading?: boolean;
  onSelectProvider: (name: string) => void;
  onRefreshQuota: (name: string) => void;
  onEditConfig?: () => void;
}) {
  const t = useT();
  const { locale } = useI18n();

  const allItems = useMemo(
    () => [...sections.ready, ...sections.needsSetup, ...sections.disabled],
    [sections],
  );
  const knownNames = useMemo(() => new Set(allItems.map(p => p.name)), [allItems]);

  const cooldownOverrides = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [name, entry] of Object.entries(providerCooldowns ?? {})) {
      if (!entry || typeof entry.until !== "number") continue;
      const reset = formatResetFuture(entry.until, t, locale);
      out[name] = t("pws.attention.capCooldown", { reset });
    }
    return out;
  }, [providerCooldowns, t, locale]);

  const cappedProviders = useMemo(() => {
    const result: Array<{ name: string; entry: ProviderCapCooldown }> = [];
    for (const [name, entry] of Object.entries(providerCooldowns ?? {})) {
      if (!entry || typeof entry.until !== "number") continue;
      result.push({ name, entry });
    }
    return result.sort((a, b) => a.entry.until - b.entry.until || a.name.localeCompare(b.name));
  }, [providerCooldowns]);
  const cappedNames = useMemo(() => new Set(cappedProviders.map(row => row.name)), [cappedProviders]);

  // Capped providers get the richer "Usage caps" section below, so keep them out of the
  // generic attention list instead of listing the same provider twice.
  const attention = useMemo(
    () => buildAttentionItems(sections, cooldownOverrides).filter(item => !cappedNames.has(item.name)),
    [sections, cooldownOverrides, cappedNames],
  );
  const attentionCount = attention.length;
  const readyReauthCount = useMemo(
    () => sections.ready.filter(p => p.activeNeedsReauth).length,
    [sections],
  );
  const readyCount = sections.ready.length - readyReauthCount;
  const needsAttentionCount = sections.needsSetup.length + readyReauthCount;

  /* Rate-limit rows: per-provider card state (ready/stale/error/loading), urgency first. */
  const quotaProviders = useMemo(() => {
    const result: Array<{ item: WorkspaceItem; report?: ProviderQuotaReportView; card: QuotaCardState; urgency: number }> = [];
    for (const item of allItems) {
      const card = quotaCards[item.name];
      if (!card || card.status === "unsupported") continue; // no quota API: no row here
      if (card.status === "error") { result.push({ item, report: card.report, card, urgency: -1 }); continue; }
      if (card.status === "loading") { result.push({ item, report: card.report, card, urgency: -1 }); continue; }
      const quota = card.report ? accountQuotaFromReport(card.report) : null;
      if (quota) result.push({ item, report: card.report, card, urgency: maxQuotaUtilisation(quota) });
    }
    return result.sort((a, b) => b.urgency - a.urgency || a.item.name.localeCompare(b.item.name));
  }, [allItems, quotaCards]);

  /* Recently-used: filter to known provider names and cap at 4 (PR #139 parity) */
  const mostUsed = useMemo(() => {
    const filtered: Record<string, ProviderUsageTotals> = {};
    for (const [name, totals] of Object.entries(usageTotals)) {
      if (knownNames.has(name)) filtered[name] = totals;
    }
    return buildMostUsedProviders(filtered).slice(0, 4);
  }, [usageTotals, knownNames]);

  const localizeAttentionReason = (reason: string) => {
    const key = attentionReasonKey(reason);
    if (key === "reauth") return t("pws.attention.reauth");
    if (key === "missing") return t("pws.attention.missingCredentials");
    return reason;
  };

  const poolCount = useMemo(
    () => allItems.filter(item => (item.keyPoolCount ?? 0) >= 2).length,
    [allItems],
  );

  const availabilityByName = useMemo(() => {
    const map: Record<string, AvailabilityProviderView> = {};
    for (const row of availability ?? []) map[row.name] = row;
    return map;
  }, [availability]);

  const rowAvailability = (item: WorkspaceItem): string | null => {
    const live = availabilityByName[item.name];
    const line = providerAvailabilityLine({
      ...item,
      keyPoolCount: live?.keyPoolCount ?? item.keyPoolCount,
      fallback: live?.hopProvider
        ? [{ provider: live.hopProvider, model: live.hopModel ?? "" }]
        : item.fallback,
    });
    const parts: string[] = [];
    if (line.poolCount >= 2) parts.push(t("pws.availability.pool", { count: String(line.poolCount) }));
    if ((live?.coolingKeyCount ?? 0) > 0) {
      parts.push(t("pws.availability.cooling", { count: String(live!.coolingKeyCount) }));
    }
    if (line.hopProvider) {
      parts.push(t("pws.availability.hop", { provider: formatProviderDisplayName(line.hopProvider) }));
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  };

  const rowStatus = (item: WorkspaceItem): { label: string; tone: "ready" | "warn" | "cool" | "off" } => {
    if (cappedNames.has(item.name) || (availabilityByName[item.name]?.coolingKeyCount ?? 0) > 0) {
      return { label: cappedNames.has(item.name) ? t("pws.capCooldown.badge") : t("pws.keyCooling"), tone: "cool" };
    }
    if (item.disabled) return { label: t("prov.disabledBadge"), tone: "off" };
    if (item.activeNeedsReauth) return { label: t("pws.status.needsAttention"), tone: "warn" };
    if (item.tier) return { label: t("pws.status.ready"), tone: "ready" };
    return { label: t("pws.status.needsSetup"), tone: "warn" };
  };

  return (
    <div className="pws-dashboard">
      <div className="pws-dashboard-header">
        <div className="pws-dashboard-header-text">
          <p className="muted pws-dashboard-subtitle">{t("pws.dashboard.subtitle")}</p>
        </div>
        {onEditConfig && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onEditConfig}>
            {t("prov.editJson")}
          </button>
        )}
      </div>

      <div className="pws-dashboard-stats" role="status">
        <div className="pws-dashboard-stat">
          <span className="pws-dashboard-stat-count num">{readyCount}</span>
          <span className="pws-dashboard-stat-label caps">{t("pws.status.ready")}</span>
        </div>
        <div className="pws-dashboard-stat">
          <span className="pws-dashboard-stat-count num pws-dashboard-stat-count--warn">{needsAttentionCount}</span>
          <span className="pws-dashboard-stat-label caps">{readyReauthCount > 0 ? t("pws.status.needsAttention") : t("pws.status.needsSetup")}</span>
        </div>
        <div className="pws-dashboard-stat">
          <span className="pws-dashboard-stat-count num">{sections.disabled.length}</span>
          <span className="pws-dashboard-stat-label caps">{t("prov.disabledBadge")}</span>
        </div>
        <div className="pws-dashboard-stat">
          <span className="pws-dashboard-stat-count num">{poolCount}</span>
          <span className="pws-dashboard-stat-label caps">{t("pws.availability.pools")}</span>
        </div>
      </div>

      {cappedProviders.length > 0 && (
        <section className="pws-dashboard-section pws-dashboard-caps" aria-label={t("pws.capCooldown.section")}>
          <h3 className="pws-dashboard-section-title">
            <IconAlert size={15} aria-hidden="true" />
            {t("pws.capCooldown.section")}
          </h3>
          <div className="pws-dashboard-group">
            {cappedProviders.map(({ name, entry }) => {
              const reset = formatResetFuture(entry.until, t, locale);
              return (
                <button
                  key={name}
                  type="button"
                  className="pws-dashboard-row pws-dashboard-row--attention"
                  onClick={() => onSelectProvider(name)}
                >
                  <ProviderIcon name={name} adapter="" baseUrl="" cls="pws-dashboard-row-icon" />
                  <div className="pws-dashboard-row-info">
                    <span className="pws-dashboard-row-name">{formatProviderDisplayName(name)}</span>
                    <span className="pws-dashboard-row-meta muted">
                      {t("pws.capCooldown.banner", {
                        provider: formatProviderDisplayName(name),
                        reset,
                      })}
                      {" "}
                      {entry.disabledProvider ? t("pws.capCooldown.disabled") : t("pws.capCooldown.paused")}
                    </span>
                  </div>
                  <IconChevron className="pws-dashboard-row-chevron" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </section>
      )}

      {attentionCount > 0 && (
        <section className="pws-dashboard-section pws-dashboard-attention" aria-label={t("pws.attentionTitle")}>
          <h3 className="pws-dashboard-section-title">
            <IconAlert size={15} aria-hidden="true" />
            {t("pws.attentionTitle")}
          </h3>
          <div className="pws-dashboard-group">
            {attention.map(item => (
              <button
                key={`${item.name}:${item.reason}`}
                type="button"
                className="pws-dashboard-row pws-dashboard-row--attention"
                onClick={() => onSelectProvider(item.name)}
              >
                <ProviderIcon name={item.name} adapter="" baseUrl="" cls="pws-dashboard-row-icon" />
                <div className="pws-dashboard-row-info">
                  <span className="pws-dashboard-row-name">{formatProviderDisplayName(item.name)}</span>
                  <span className="pws-dashboard-row-meta muted">{localizeAttentionReason(item.reason)}</span>
                </div>
                <IconChevron className="pws-dashboard-row-chevron" aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="pws-dashboard-section" aria-label={t("pws.dashboard.configuredProviders")}>
        <h3 className="pws-dashboard-section-title">{t("pws.dashboard.configuredProviders")}</h3>
        {allItems.length > 0 ? (
          <div className="pws-dashboard-group">
            {allItems.map(item => {
              const line = rowAvailability(item);
              const status = rowStatus(item);
              return (
              <button
                key={item.name}
                type="button"
                className="pws-dashboard-row"
                onClick={() => onSelectProvider(item.name)}
              >
                <ProviderIcon name={item.name} adapter={item.adapter} baseUrl={item.baseUrl} cls="pws-dashboard-row-icon" />
                <div className="pws-dashboard-row-info">
                  <span className="pws-dashboard-row-name">{formatProviderDisplayName(item.name)}</span>
                  {line && (
                    <span className="pws-dashboard-row-meta muted">{line}</span>
                  )}
                </div>
                <span className={`pws-dashboard-status pws-dashboard-status--${status.tone}`}>
                  <StatusMark tone={status.tone} />
                  {status.label}
                </span>
                <IconChevron className="pws-dashboard-row-chevron" aria-hidden="true" />
              </button>
              );
            })}
          </div>
        ) : (
          <p className="muted pws-dashboard-empty">{t("pws.dashboard.noConfiguredProviders")}</p>
        )}
      </section>

      <div className="pws-dashboard-columns">
        <section
          className="pws-dashboard-section pws-dashboard-section--rate-limits"
          aria-label={t("pws.dashboard.rateLimits")}
          aria-busy={quotasLoading || undefined}
        >
          <h3 className="pws-dashboard-section-title">{t("pws.dashboard.rateLimits")}</h3>
          {quotaProviders.length > 0 ? (
            <div className="pws-dashboard-rows">
              {quotaProviders.map(({ item, report, card }) => {
                const rowClass = `pws-dashboard-row${card.status === "error" ? " quota-card-error" : ""}`;
                const stamp =
                  card.status === "error" ? (
                    <span className="quota-stamp quota-stamp--fout">{t("pws.quota.fout")}</span>
                  ) : card.status === "stale" ? (
                    <span className="quota-stamp quota-stamp--verouderd">{t("pws.quota.verouderd")}{report?.updatedAt ? ` · ${clockTime(report.updatedAt)}` : ""}</span>
                  ) : (
                    <span className="quota-stamp quota-stamp--vers">{t("pws.quota.vers")} · {report?.updatedAt ? clockTime(report.updatedAt) : ""}</span>
                  );
                return (
                  <div key={item.name} className={rowClass}>
                    <div className="pws-dashboard-row-select"
                      role="button" tabIndex={0}
                      onClick={() => onSelectProvider(item.name)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectProvider(item.name); } }}>
                      <ProviderIcon name={item.name} adapter={item.adapter} baseUrl={item.baseUrl} cls="pws-dashboard-row-icon" />
                      <div className="pws-dashboard-row-info">
                        <span className="pws-dashboard-row-name">{formatProviderDisplayName(item.name)}</span>
                        <span className="pws-dashboard-row-meta muted">{stamp}</span>
                      </div>
                      {card.status !== "error" ? (
                        <IconChevron className="pws-dashboard-row-chevron" aria-hidden="true" />
                      ) : null}
                      <div className="pws-dashboard-row-bars">
                        {card.status === "error" ? (
                          <span className="quota-stamp quota-stamp--fout">{card.nextRetryAt ? t("pws.quota.retryAt", { time: clockTime(card.nextRetryAt) }) : ""}</span>
                        ) : (
                          <QuotaBars quota={report ? accountQuotaFromReport(report) : null} threshold={80} t={t} layout="stacked" pending={card.status === "loading" || !report?.quota} />
                        )}
                      </div>
                    </div>
                    {card.status === "error" ? (
                      <button type="button" className="link-btn quota-retry"
                        onClick={() => onRefreshQuota(item.name)}>
                        {t("pws.quota.retry")}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : quotasLoading ? (
            <div className="pws-dashboard-rows pws-dashboard-rows--pending" aria-hidden="true">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="pws-dashboard-row pws-dashboard-row--skeleton">
                  <span className="pws-dashboard-row-icon pws-skel" />
                  <div className="pws-dashboard-row-info">
                    <span className="pws-skel pws-skel--name" />
                    <span className="pws-skel pws-skel--meta" />
                  </div>
                  <div className="pws-dashboard-row-bars">
                    <QuotaBars quota={null} threshold={80} t={t} layout="stacked" pending />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted pws-dashboard-empty">{t("pws.dashboard.noRateLimits")}</p>
          )}
        </section>

        <section
          className="pws-dashboard-section pws-dashboard-section--recent"
          aria-label={t("pws.dashboard.recentlyUsed")}
          aria-busy={usageLoading || undefined}
        >
          <h3 className="pws-dashboard-section-title">{t("pws.dashboard.recentlyUsed")}</h3>
          {mostUsed.length > 0 ? (
            <div className="pws-dashboard-rows">
              {mostUsed.map(provider => (
                <button
                  key={provider.name}
                  type="button"
                  className="pws-dashboard-row"
                  onClick={() => onSelectProvider(provider.name)}
                >
                  <ProviderIcon name={provider.name} adapter="" baseUrl="" cls="pws-dashboard-row-icon" />
                  <span className="pws-dashboard-row-name">{formatProviderDisplayName(provider.name)}</span>
                  <span className="pws-dashboard-row-count muted">
                    {t("pws.dashboard.requests", { count: formatRequestCount(provider.requests, locale) })}
                  </span>
                  <IconChevron className="pws-dashboard-row-chevron" aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : usageLoading ? (
            <div className="pws-dashboard-rows pws-dashboard-rows--pending" aria-hidden="true">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="pws-dashboard-row pws-dashboard-row--skeleton">
                  <span className="pws-dashboard-row-icon pws-skel" />
                  <span className="pws-skel pws-skel--name" />
                  <span className="pws-skel pws-skel--count" />
                </div>
              ))}
            </div>
          ) : (
            <p className="muted pws-dashboard-empty">{t("pws.dashboard.noUsage")}</p>
          )}
        </section>
      </div>
    </div>
  );
}
