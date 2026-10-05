import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useKeyedClientResource } from "../client-resource";
import { useT, useI18n } from "../i18n/shared";
import { formatUptime } from "../formatUptime";
import { formatProviderDisplayName } from "../provider-icons";
import { applyActiveAccountReauth, buildProviderWorkspace } from "../provider-workspace/catalog";
import { TrafficRowCells } from "../traffic-row";
import { requestsTodayCount, type TrafficLogEntry } from "../traffic-shared";
import { StatusBadge } from "../ui";
import {
  buildActiveNeedsReauthMap,
  buildCapacityRows,
  buildOverviewIssues,
  rollupAccounts,
  trafficOperationalStatus,
  type OAuthAccountRow,
} from "./dashboard-overview";
import type { ProvidersConfig } from "./providers-shared";

interface Healthz {
  status: string;
  service: string;
  version: string;
  uptime: number;
  pid: number;
  port: number;
}

function tijd(ts: number, locale: string): string {
  return new Date(ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function bonTokens(entry: TrafficLogEntry): number | undefined {
  if (entry.usage) return entry.usage.totalTokens ?? entry.usage.inputTokens + entry.usage.outputTokens;
  return entry.totalTokens;
}

export default function Dashboard({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { locale } = useI18n();

  const health = useKeyedClientResource<Healthz | null>(
    `dash-healthz:${apiBase}`,
    [],
    async (signal) => {
      const res = await fetch(`${apiBase}/healthz`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as Healthz;
    },
    { pollMs: 15_000 },
  );

  const [config, setConfig] = useState<ProvidersConfig | null>(null);
  const [oauthProviders, setOauthProviders] = useState<string[]>([]);
  const [accountSets, setAccountSets] = useState<Record<string, { accounts: OAuthAccountRow[] }>>({});
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [logs, setLogs] = useState<TrafficLogEntry[]>([]);
  const [logsLoaded, setLogsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [configRes, logsRes, oauthRes] = await Promise.all([
          fetch(`${apiBase}/api/config`),
          fetch(`${apiBase}/api/logs`),
          fetch(`${apiBase}/api/oauth/providers`),
        ]);
        if (!cancelled && configRes.ok) {
          setConfig((await configRes.json()) as ProvidersConfig);
        }
        if (!cancelled && logsRes.ok) {
          const data = (await logsRes.json()) as TrafficLogEntry[];
          setLogs(Array.isArray(data) ? data.toSorted((a, b) => b.timestamp - a.timestamp) : []);
          setLogsLoaded(true);
        }
        if (!cancelled && oauthRes.ok) {
          const body = (await oauthRes.json()) as { providers?: string[] };
          const providers = body.providers ?? [];
          setOauthProviders(providers);
          if (providers.length === 0) {
            setAccountsLoaded(true);
            return;
          }
          const entries = await Promise.all(providers.map(async provider => {
            const res = await fetch(`${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}`).catch(() => null);
            if (!res?.ok) return [provider, { accounts: [] as OAuthAccountRow[] }] as const;
            const data = await res.json() as { accounts?: OAuthAccountRow[] };
            return [provider, { accounts: data.accounts ?? [] }] as const;
          }));
          if (!cancelled) {
            setAccountSets(Object.fromEntries(entries));
            setAccountsLoaded(true);
          }
        }
      } catch { /* keep last-good */ }
    };
    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [apiBase]);

  const proxyOnline = health.data ? true : health.error ? false : null;
  const providerCount = config ? Object.keys(config.providers).length : null;
  const activeNeedsReauth = useMemo(() => buildActiveNeedsReauthMap(accountSets), [accountSets]);
  const accountRollup = useMemo(
    () => rollupAccounts(accountSets, oauthProviders),
    [accountSets, oauthProviders],
  );
  const requestsToday = useMemo(() => requestsTodayCount(logs, undefined), [logs]);
  const capacityRows = useMemo(
    () => (config ? buildCapacityRows(config.providers, accountSets, activeNeedsReauth) : []),
    [config, accountSets, activeNeedsReauth],
  );
  const issues = useMemo(
    () => (config ? buildOverviewIssues(config.providers, accountSets, activeNeedsReauth, config.providerCooldowns) : []),
    [config, accountSets, activeNeedsReauth],
  );
  const recentTraffic = useMemo(() => logs.slice(0, 10), [logs]);
  const workspace = useMemo(
    () => (config ? applyActiveAccountReauth(buildProviderWorkspace(config.providers, accountSets), activeNeedsReauth) : null),
    [config, accountSets, activeNeedsReauth],
  );
  const degradedProviders = workspace
    ? workspace.needsSetup.length + workspace.ready.filter(p => p.activeNeedsReauth).length
    : null;

  const statusSegments: Array<{ key: string; node: ReactNode }> = [];
  statusSegments.push({
    key: "proxy",
    node: proxyOnline === null
      ? <span className="muted">{t("dash.overview.checking")}</span>
      : <StatusBadge status={proxyOnline ? "healthy" : "degraded"}>{proxyOnline ? t("dash.overview.operational") : t("dash.overview.offline")}</StatusBadge>,
  });
  if (providerCount !== null) {
    statusSegments.push({
      key: "providers",
      node: <span>{t("dash.overview.providers", { count: providerCount })}</span>,
    });
  }
  if (accountsLoaded && accountRollup.loaded) {
    statusSegments.push({
      key: "ready",
      node: <span>{t("dash.overview.accountsReady", { count: accountRollup.ready })}</span>,
    });
    if (accountRollup.degraded > 0) {
      statusSegments.push({
        key: "degraded-accts",
        node: <span>{t("dash.overview.accountsDegraded", { count: accountRollup.degraded })}</span>,
      });
    }
  } else if (accountsLoaded && oauthProviders.length > 0 && !accountRollup.loaded) {
    statusSegments.push({
      key: "accounts-unknown",
      node: <span className="muted">{t("dash.overview.accountsUnknown")}</span>,
    });
  }
  if (degradedProviders !== null && degradedProviders > 0) {
    statusSegments.push({
      key: "providers-degraded",
      node: <span>{t("dash.overview.providersDegraded", { count: degradedProviders })}</span>,
    });
  }
  if (logsLoaded) {
    statusSegments.push({
      key: "requests",
      node: <span>{t("dash.overview.requestsToday", { count: requestsToday.toLocaleString(locale) })}</span>,
    });
  }
  if (health.data) {
    statusSegments.push({
      key: "meta",
      node: <span className="mono muted">{health.data.version} · {formatUptime(health.data.uptime, locale)}</span>,
    });
  }

  return (
    <>
      <div className="page-head dash-overview-head">
        <h2>{t("nav.dashboard")}</h2>
        <p className="page-sub">{t("dash.subtitle")}</p>
      </div>

      <div className="dash-overview-status" role="status" aria-live="polite">
        {statusSegments.map((segment, index) => (
          <span key={segment.key} className="dash-overview-status__segment">
            {index > 0 && <span className="dash-overview-status__sep" aria-hidden="true">·</span>}
            {segment.node}
          </span>
        ))}
      </div>

      <div className="dash-overview-blocks">
        <section className="dash-overview-block" aria-label={t("dash.overview.capacity")}>
          <h3 className="dash-overview-block-title">{t("dash.overview.capacity")}</h3>
          {!config ? (
            <p className="muted dash-overview-empty">{t("dash.overview.loading")}</p>
          ) : capacityRows.length > 0 ? (
            <ul className="dash-overview-list">
              {capacityRows.map(row => (
                <li key={row.provider} className="dash-overview-list-row">
                  <span className="dash-overview-list-name">{formatProviderDisplayName(row.provider)}</span>
                  <StatusBadge status={row.status}>{t(row.detailKey, row.detailVars)}</StatusBadge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted dash-overview-empty">{t("dash.noProviders", { cmd: "ocx doctor" })}</p>
          )}
        </section>

        <section className="dash-overview-block" aria-label={t("dash.overview.traffic")}>
          <h3 className="dash-overview-block-title">{t("dash.overview.traffic")}</h3>
          {!logsLoaded ? (
            <p className="muted dash-overview-empty">{t("dash.overview.loading")}</p>
          ) : recentTraffic.length > 0 ? (
            <div className="dash-overview-traffic">
              {recentTraffic.map(entry => {
                const id = entry.requestId ?? `${entry.timestamp}-${entry.provider}-${entry.model}`;
                return (
                  <div key={id} className="dash-overview-traffic-row">
                    <span className="mono dash-overview-traffic-time">{tijd(entry.timestamp, locale)}</span>
                    <span className="dash-overview-traffic-model">{entry.provider}/{entry.model}</span>
                    <StatusBadge status={trafficOperationalStatus(entry)}>
                      {entry.status || "—"}
                    </StatusBadge>
                    <span className="muted mono dash-overview-traffic-latency">
                      {t("vk.rowDuration", { s: (entry.durationMs / 1000).toFixed(1) })}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted dash-overview-empty">{t("vk.empty")}</p>
          )}
        </section>

        <section className="dash-overview-block" aria-label={t("dash.overview.issues")}>
          <h3 className="dash-overview-block-title">{t("dash.overview.issues")}</h3>
          {!config ? (
            <p className="muted dash-overview-empty">{t("dash.overview.loading")}</p>
          ) : issues.length > 0 ? (
            <ul className="dash-overview-list">
              {issues.map(issue => (
                <li key={issue.id} className="dash-overview-list-row">
                  <span className="dash-overview-list-name">{formatProviderDisplayName(issue.provider)}</span>
                  <StatusBadge status={issue.status}>{t(issue.detailKey, issue.detailVars)}</StatusBadge>
                </li>
              ))}
            </ul>
          ) : (
            <div className="dash-overview-empty">
              <StatusBadge status="healthy">{t("dash.overview.noIssues")}</StatusBadge>
            </div>
          )}
        </section>
      </div>

      <section className="panel dash-overview-activity" aria-label={t("dash.overview.recentActivity")}>
        <div className="panel-head">
          <h3 className="panel-title">{t("dash.overview.recentActivity")}</h3>
        </div>
        {!logsLoaded ? (
          <p className="muted dash-overview-empty">{t("dash.overview.loading")}</p>
        ) : recentTraffic.length > 0 ? (
          <div className="dash-overview-activity-rows">
            {recentTraffic.slice(0, 8).map(entry => {
              const id = entry.requestId ?? `${entry.timestamp}-${entry.provider}-${entry.model}`;
              const tokens = bonTokens(entry);
              return (
                <div key={id} className="bon" style={{ borderBottom: "1px solid var(--border-soft)" }}>
                  <div className="bon-kop bon-kop--grid dash-overview-activity-row">
                    <span className="bon-col bon-col--time bon-tijd">{tijd(entry.timestamp, locale)}</span>
                    <TrafficRowCells entry={entry} locale={locale} tokens={tokens} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted dash-overview-empty">{t("vk.empty")}</p>
        )}
      </section>
    </>
  );
}
