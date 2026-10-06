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

export function buildActiveNeedsReauthMap(
  sets: AccountSets,
): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(sets).map(([provider, set]) => {
      const active =
        set.accounts.find((a) => a.active) ??
        set.accounts.find((a) => a.id === set.activeAccountId);
      return [provider, accountNeedsReauth(active)];
    }),
  );
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
      const active =
        set.accounts.find((a) => a.active) ??
        set.accounts.find((a) => a.id === set.activeAccountId);
      const status = active ? accountOperationalStatus(active) : "unknown";
      const count = set.accounts.filter(
        (a) => accountOperationalStatus(a) === "healthy",
      ).length;
      return {
        provider: item.name,
        status,
        detailKey:
          status === "healthy"
            ? "dash.overview.capReady"
            : status === "rate-limited"
              ? "dash.overview.issueRateLimit"
              : status === "cooldown"
                ? "dash.overview.issueCooldown"
                : status === "auth-failed"
                  ? "dash.overview.issueReauth"
                  : status === "expired"
                    ? "health.status.expired"
                    : status === "degraded"
                      ? "dash.overview.issueDegraded"
                      : "dash.overview.capInsufficient",
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
      const set = sets[provider];
      if (!set) {
        issues.push({
          provider,
          status: "unknown",
          detailKey: "dash.overview.capInsufficient",
        });
        continue;
      }
      if (!set.accounts.length) {
        issues.push({
          provider,
          status: "auth-failed",
          detailKey: "dash.overview.issueNeedsSetup",
        });
        continue;
      }
      const active =
        set.accounts.find((a) => a.active) ??
        set.accounts.find((a) => a.id === set.activeAccountId);
      const status = active ? accountOperationalStatus(active) : "unknown";
      if (status !== "healthy")
        issues.push({
          provider,
          status,
          detailKey:
            status === "auth-failed"
              ? "dash.overview.issueReauth"
              : status === "rate-limited"
                ? "dash.overview.issueRateLimit"
                : status === "cooldown"
                  ? "dash.overview.issueCooldown"
                  : status === "expired"
                    ? "health.status.expired"
                    : status === "degraded"
                      ? "dash.overview.issueDegraded"
                      : "dash.overview.capInsufficient",
        });
    } else if (binProviderStatus(config) !== "ready")
      issues.push({
        provider,
        status: "auth-failed",
        detailKey: "dash.overview.issueNeedsSetup",
      });
  }
  return issues.slice(0, 8);
}
