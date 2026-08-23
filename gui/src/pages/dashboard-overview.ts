import type { OperationalStatus } from "../design-tokens";
import {
  oauthHealthOperationalStatus,
  type OAuthHealthView,
} from "../oauth-health-display";
import {
  applyActiveAccountReauth,
  buildProviderWorkspace,
  type WorkspaceProvider,
} from "../provider-workspace/catalog";
import type { ProviderCapCooldown } from "./providers-shared";
import type { TrafficLogEntry } from "../traffic-shared";

export interface OAuthAccountRow {
  id: string;
  active?: boolean;
  needsReauth?: boolean;
  health?: OAuthHealthView;
}

export interface AccountRollup {
  ready: number;
  degraded: number;
  loaded: boolean;
}

export interface OverviewIssue {
  id: string;
  provider: string;
  status: OperationalStatus;
  detailKey: "dash.overview.issueReauth" | "dash.overview.issueRateLimit" | "dash.overview.issueCooldown" | "dash.overview.issueCapCooldown" | "dash.overview.issueNeedsSetup" | "dash.overview.issueDegraded";
  detailVars?: Record<string, string>;
}

export interface CapacityRow {
  provider: string;
  status: OperationalStatus;
  detailKey: "dash.overview.capReady" | "dash.overview.capCooldown" | "dash.overview.capRateLimit" | "dash.overview.capAuthFailed" | "dash.overview.capNeedsSetup" | "dash.overview.capDisabled" | "dash.overview.capKeyReady" | "dash.overview.capInsufficient";
  detailVars?: Record<string, string | number>;
}

export function trafficOperationalStatus(entry: TrafficLogEntry): OperationalStatus {
  if (entry.status >= 200 && entry.status < 300) return "healthy";
  if (entry.status === 429) return "rate-limited";
  if (entry.status === 401 || entry.status === 403) return "auth-failed";
  if (entry.status >= 400 || entry.status === 0) return "degraded";
  return "unknown";
}

export function rollupAccounts(
  accountSets: Record<string, { accounts: OAuthAccountRow[] }>,
  oauthProviders: readonly string[],
): AccountRollup {
  if (oauthProviders.length === 0) {
    return { ready: 0, degraded: 0, loaded: false };
  }

  let loadedProviders = 0;
  let ready = 0;
  let degraded = 0;

  for (const provider of oauthProviders) {
    const set = accountSets[provider];
    if (!set) continue;
    loadedProviders += 1;
    for (const account of set.accounts) {
      const status = oauthHealthOperationalStatus(account.health ?? (account.needsReauth ? { status: "reauth_required" } : { status: "healthy" }));
      if (status === "healthy") ready += 1;
      else degraded += 1;
    }
  }

  return {
    ready,
    degraded,
    loaded: loadedProviders > 0,
  };
}

function accountStatusCounts(accounts: OAuthAccountRow[]): Record<OperationalStatus, number> {
  const counts: Record<OperationalStatus, number> = {
    healthy: 0,
    degraded: 0,
    "rate-limited": 0,
    cooldown: 0,
    expired: 0,
    "auth-failed": 0,
    disabled: 0,
    unknown: 0,
  };
  for (const account of accounts) {
    const status = oauthHealthOperationalStatus(
      account.health ?? (account.needsReauth ? { status: "reauth_required" } : { status: "healthy" }),
    );
    counts[status] += 1;
  }
  return counts;
}

export function buildCapacityRows(
  providers: Record<string, WorkspaceProvider>,
  accountSets: Record<string, { accounts: OAuthAccountRow[] }>,
  activeNeedsReauth: Record<string, boolean>,
  limit = 3,
): CapacityRow[] {
  const sections = applyActiveAccountReauth(buildProviderWorkspace(providers), activeNeedsReauth);
  const needsSetupNames = new Set(sections.needsSetup.map(p => p.name));
  const candidates = [...sections.ready, ...sections.needsSetup].slice(0, limit);
  const rows: CapacityRow[] = [];

  for (const item of candidates) {
    if (item.disabled) {
      rows.push({ provider: item.name, status: "disabled", detailKey: "dash.overview.capDisabled" });
      continue;
    }
    if (needsSetupNames.has(item.name)) {
      rows.push({ provider: item.name, status: "auth-failed", detailKey: "dash.overview.capNeedsSetup" });
      continue;
    }
    const accounts = accountSets[item.name]?.accounts;
    if (item.authMode === "oauth") {
      if (!accounts) {
        rows.push({ provider: item.name, status: "unknown", detailKey: "dash.overview.capInsufficient" });
        continue;
      }
      const counts = accountStatusCounts(accounts);
      if (counts["rate-limited"] > 0) {
        rows.push({
          provider: item.name,
          status: "rate-limited",
          detailKey: "dash.overview.capRateLimit",
          detailVars: { count: counts["rate-limited"] },
        });
        continue;
      }
      if (counts.cooldown > 0) {
        rows.push({
          provider: item.name,
          status: "cooldown",
          detailKey: "dash.overview.capCooldown",
          detailVars: { count: counts.cooldown },
        });
        continue;
      }
      if (counts["auth-failed"] > 0 || counts.degraded > 0) {
        rows.push({
          provider: item.name,
          status: "auth-failed",
          detailKey: "dash.overview.capAuthFailed",
          detailVars: { count: counts["auth-failed"] + counts.degraded },
        });
        continue;
      }
      rows.push({
        provider: item.name,
        status: "healthy",
        detailKey: "dash.overview.capReady",
        detailVars: { count: counts.healthy },
      });
      continue;
    }
    rows.push({ provider: item.name, status: "healthy", detailKey: "dash.overview.capKeyReady" });
  }

  return rows;
}

export function buildOverviewIssues(
  providers: Record<string, WorkspaceProvider>,
  accountSets: Record<string, { accounts: OAuthAccountRow[] }>,
  activeNeedsReauth: Record<string, boolean>,
  cooldowns: Record<string, ProviderCapCooldown> | undefined,
): OverviewIssue[] {
  const sections = applyActiveAccountReauth(buildProviderWorkspace(providers), activeNeedsReauth);
  const issues: OverviewIssue[] = [];

  for (const [provider, entry] of Object.entries(cooldowns ?? {})) {
    if (!entry || typeof entry.until !== "number") continue;
    issues.push({
      id: `${provider}/cap`,
      provider,
      status: "rate-limited",
      detailKey: "dash.overview.issueCapCooldown",
      detailVars: { reason: entry.reason || entry.message || "cap" },
    });
  }

  for (const item of sections.needsSetup) {
    issues.push({
      id: `${item.name}/setup`,
      provider: item.name,
      status: "auth-failed",
      detailKey: "dash.overview.issueNeedsSetup",
    });
  }

  for (const item of sections.ready) {
    if (item.activeNeedsReauth) {
      issues.push({
        id: `${item.name}/reauth`,
        provider: item.name,
        status: "auth-failed",
        detailKey: "dash.overview.issueReauth",
      });
    }
    const accounts = accountSets[item.name]?.accounts ?? [];
    for (const account of accounts) {
      const status = oauthHealthOperationalStatus(
        account.health ?? (account.needsReauth ? { status: "reauth_required" } : undefined),
      );
      if (status === "healthy" || status === "unknown" || status === "disabled") continue;
      issues.push({
        id: `${item.name}/${account.id}`,
        provider: item.name,
        status,
        detailKey: status === "rate-limited"
          ? "dash.overview.issueRateLimit"
          : status === "cooldown"
            ? "dash.overview.issueCooldown"
            : status === "auth-failed"
              ? "dash.overview.issueReauth"
              : "dash.overview.issueDegraded",
      });
    }
  }

  return issues.slice(0, 8);
}

export function buildActiveNeedsReauthMap(
  accountSets: Record<string, { accounts: OAuthAccountRow[] }>,
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const [provider, set] of Object.entries(accountSets)) {
    const active = set.accounts.find(a => a.active) ?? set.accounts[0];
    if (!active) continue;
    const status = oauthHealthOperationalStatus(
      active.health ?? (active.needsReauth ? { status: "reauth_required" } : { status: "healthy" }),
    );
    if (status !== "healthy") map[provider] = true;
  }
  return map;
}
