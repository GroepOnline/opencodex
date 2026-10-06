import type { TKey } from "../i18n/shared";
import type { OperationalStatus } from "../design-tokens";
import {
  accountNeedsReauth,
  oauthHealthOperationalStatus,
  type OAuthHealthView,
} from "../oauth-health-display";
import {
  binProviderStatus,
  buildProviderWorkspace,
  type WorkspaceProvider,
} from "../provider-workspace/catalog";
import type { ProviderCapCooldown } from "./providers-shared";

export interface OAuthAccountRow {
  id: string;
  active?: boolean;
  needsReauth?: boolean;
  disabledByExpiry?: boolean;
  health?: OAuthHealthView;
}
export type AccountSets = Record<
  string,
  { activeAccountId?: string | null; accounts: OAuthAccountRow[] }
>;
export interface OverviewRow {
  provider: string;
  status: OperationalStatus;
  detailKey: TKey;
  detailVars?: Record<string, string | number>;
}

export function accountOperationalStatus(
  account: OAuthAccountRow,
): OperationalStatus {
  if (account.disabledByExpiry) return "expired";
  if (accountNeedsReauth(account)) return "auth-failed";
  return oauthHealthOperationalStatus(account.health);
}

export function rollupAccounts(sets: AccountSets, names: readonly string[]) {
  let ready = 0;
  let degraded = 0;
  for (const name of names)
    for (const account of sets[name]?.accounts ?? []) {
      const status = accountOperationalStatus(account);
      if (status === "healthy") ready++;
      else if (status !== "unknown") degraded++;
    }
  return {
    ready,
    degraded,
    loaded: names.every((name) => sets[name] !== undefined),
  };
}

const STATUS_DETAIL_KEYS: Partial<Record<OperationalStatus, TKey>> = {
  "rate-limited": "dash.overview.issueRateLimit",
  cooldown: "dash.overview.issueCooldown",
  "auth-failed": "dash.overview.issueReauth",
  expired: "health.status.expired",
  degraded: "dash.overview.issueDegraded",
};
function activeAccountStatus(set: AccountSets[string]): OperationalStatus {
  const active =
    set.accounts.find((account) => account.active) ??
    set.accounts.find((account) => account.id === set.activeAccountId);
  return active ? accountOperationalStatus(active) : "unknown";
}
function oauthIssue(
  provider: string,
  set: AccountSets[string] | undefined,
): OverviewRow | undefined {
  if (!set)
    return {
      provider,
      status: "unknown",
      detailKey: "dash.overview.capInsufficient",
    };
  if (!set.accounts.length)
    return {
      provider,
      status: "auth-failed",
      detailKey: "dash.overview.issueNeedsSetup",
    };
  const status = activeAccountStatus(set);
  if (status === "healthy") return undefined;
  return {
    provider,
    status,
    detailKey: STATUS_DETAIL_KEYS[status] ?? "dash.overview.capInsufficient",
  };
}

export function buildCapacityRows(
  providers: Record<string, WorkspaceProvider>,
  sets: AccountSets,
): OverviewRow[] {
  const sections = buildProviderWorkspace(providers, sets);
  return [...sections.ready, ...sections.needsSetup]
    .map((item): OverviewRow => {
      if (item.authMode !== "oauth" || item.keyOptional)
        return {
          provider: item.name,
          status:
            binProviderStatus(item) === "ready" ? "healthy" : "auth-failed",
          detailKey:
            binProviderStatus(item) === "ready"
              ? "dash.overview.capKeyReady"
              : "dash.overview.capNeedsSetup",
        } satisfies OverviewRow;
      const set = sets[item.name];
      if (!set)
        return {
          provider: item.name,
          status: "unknown",
          detailKey: "dash.overview.capInsufficient",
        };
      if (set.accounts.length === 0)
        return {
          provider: item.name,
          status: "auth-failed",
          detailKey: "dash.overview.capNeedsSetup",
        };
      const status = activeAccountStatus(set);
      const count = set.accounts.filter(
        (a) => accountOperationalStatus(a) === "healthy",
      ).length;
      return {
        provider: item.name,
        status,
        detailKey:
          status === "healthy"
            ? "dash.overview.capReady"
            : (STATUS_DETAIL_KEYS[status] ?? "dash.overview.capInsufficient"),
        detailVars: { count },
      };
    })
    .slice(0, 3);
}

export function buildOverviewIssues(
  providers: Record<string, WorkspaceProvider>,
  sets: AccountSets,
  cooldowns?: Record<string, ProviderCapCooldown>,
): OverviewRow[] {
  const issues: OverviewRow[] = [];
  for (const [provider, config] of Object.entries(providers)) {
    if (config.disabled) continue;
    const cap = cooldowns?.[provider];
    if (cap && cap.until > Date.now())
      issues.push({
        provider,
        status: "rate-limited",
        detailKey: "dash.overview.issueCapCooldown",
        detailVars: { reason: cap.reason },
      });
    if (config.authMode === "oauth" && !config.keyOptional) {
      const issue = oauthIssue(provider, sets[provider]);
      if (issue) issues.push(issue);
    } else if (binProviderStatus(config) !== "ready")
      issues.push({
        provider,
        status: "auth-failed",
        detailKey: "dash.overview.issueNeedsSetup",
      });
  }
  return issues.slice(0, 8);
}
