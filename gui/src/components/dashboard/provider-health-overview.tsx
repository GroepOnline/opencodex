import { useKeyedClientResource } from "../../client-resource";
import { useI18n } from "../../i18n/shared";
import { formatProviderDisplayName } from "../../provider-icons";
import { hideRedundantChatGptForwardProviders } from "../../provider-workspace/catalog";
import {
  buildCapacityRows,
  buildOverviewIssues,
  rollupAccounts,
  accountOperationalStatus,
  type AccountSets,
  type OverviewRow,
} from "../../pages/dashboard-overview";
import type { ProvidersConfig } from "../../pages/providers-shared";
import { StatusBadge } from "../../ui";
import { Panel, PanelHeader } from "../primitives/panel";
import { DataList, DataRow } from "../primitives/data-list";

export function ProviderHealthOverview({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const config = useKeyedClientResource<ProvidersConfig>(
    `dash-provider-config:${apiBase}`,
    [],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/config`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    },
    { pollMs: 30_000 },
  );
  const providers = hideRedundantChatGptForwardProviders(
    config.data?.providers,
  );
  const names = Object.entries(providers)
    .filter(([, p]) => p.authMode === "oauth" && !p.disabled)
    .map(([name]) => name)
    .sort();
  const nameKey = JSON.stringify(names);
  const accounts = useKeyedClientResource<{
    sets: AccountSets;
    failed: boolean;
  }>(
    `dash-provider-accounts:${apiBase}:${nameKey}`,
    [],
    async (signal) => {
      const results = await Promise.all(
        names.map(async (provider) => {
          try {
            const res = await fetch(
              `${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}`,
              { signal },
            );
            if (!res.ok) throw new Error(String(res.status));
            const body = (await res.json()) as AccountSets[string];
            if (!Array.isArray(body.accounts))
              throw new Error("Invalid account list");
            return [provider, body] as const;
          } catch {
            return null;
          }
        }),
      );
      return {
        sets: Object.fromEntries(results.filter((row) => row !== null)),
        failed: results.some((row) => row === null),
      };
    },
    { enabled: config.data !== undefined, pollMs: 30_000 },
  );
  const sets = accounts.data?.sets ?? {};
  const rollup = rollupAccounts(sets, names);
  const capacity = buildCapacityRows(providers, sets);
  const issues = buildOverviewIssues(
    providers,
    sets,
    config.data?.providerCooldowns,
  );
  const unknown =
    !!config.error ||
    !!accounts.error ||
    accounts.data === undefined ||
    accounts.data.failed ||
    names.some((name) =>
      sets[name]?.accounts.some(
        (account) => accountOperationalStatus(account) === "unknown",
      ),
    );
  const rows = (items: OverviewRow[]) => (
    <DataList>
      {items.map((row) => (
        <DataRow key={`${row.provider}/${row.detailKey}`}>
          <span>{formatProviderDisplayName(row.provider)}</span>
          <StatusBadge status={row.status}>
            {t(row.detailKey, row.detailVars)}
          </StatusBadge>
        </DataRow>
      ))}
    </DataList>
  );
  return (
    <div className="pws-dashboard-columns">
      <Panel titleId="dash-capacity-title">
        <PanelHeader
          titleId="dash-capacity-title"
          title={t("dash.overview.capacity")}
        />
        <p className="muted">
          {unknown || !rollup.loaded
            ? t("dash.overview.accountsUnknown")
            : t("dash.overview.accountsReady", { count: rollup.ready })}
        </p>
        {capacity.length ? (
          rows(capacity)
        ) : (
          <p className="muted">
            {t(config.data ? "dash.overview.capInsufficient" : "common.loading")}
          </p>
        )}
      </Panel>
      <Panel titleId="dash-issues-title">
        <PanelHeader
          titleId="dash-issues-title"
          title={t("dash.overview.issues")}
        />
        {unknown ? (
          <p className="muted">{t("dash.overview.accountsUnknown")}</p>
        ) : null}
        {issues.length ? (
          rows(issues)
        ) : !unknown ? (
          <StatusBadge status="healthy">
            {t("dash.overview.noIssues")}
          </StatusBadge>
        ) : null}
      </Panel>
    </div>
  );
}
