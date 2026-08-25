/**
 * Unified same-provider account runtime (GRO-1497).
 *
 * Not a new gateway and not cross-provider routing. One read-model for OAuth
 * accounts (Anthropic / Cursor / Antigravity) and API-key pool entries:
 * cooldown + lastUsed + inFlight + operator seat expiry.
 */
import { listAccounts, loadAuthStore } from "../oauth/store";
import {
  isAccountDisabledForRouting,
  isProviderAccountSelectable,
} from "../oauth/account-expiry";
import type { ProviderAccount } from "../oauth/types";
import { getAnthropicAccountHealthSnapshot, getAnthropicAccountLastUsedAt } from "../oauth/anthropic-routing";
import { getCursorAccountHealthSnapshot, getCursorAccountLastUsedAt } from "../oauth/cursor-routing";
import { getGoogleAntigravityAccountHealthSnapshot, getGoogleAntigravityAccountLastUsedAt } from "../oauth/google-antigravity-routing";
import { getKeyCooldownUntil } from "./key-failover";
import { listProviderApiKeys } from "./api-keys";
import {
  getProviderAccountOccupancy,
  type ProviderAccountKind,
} from "./account-runtime-state";
import type { OcxConfig } from "../types";

export type { ProviderAccountKind } from "./account-runtime-state";
export {
  bindRequestProviderAccount,
  releaseRequestProviderAccount,
  noteProviderAccountUsed,
  beginProviderAccountRequest,
  endProviderAccountRequest,
  getProviderAccountOccupancy,
  clearProviderAccountRuntimeState,
} from "./account-runtime-state";

const OAUTH_RUNTIME_PROVIDERS = ["anthropic", "cursor", "google-antigravity"] as const;
export type OauthRuntimeProvider = (typeof OAUTH_RUNTIME_PROVIDERS)[number];

export function isOauthRuntimeProvider(provider: string): provider is OauthRuntimeProvider {
  return (OAUTH_RUNTIME_PROVIDERS as readonly string[]).includes(provider);
}

export type ProviderAccountDisabledReason = "expired" | "needs_reauth";
export type ProviderAccountCooldownSource = "retry-after" | "default" | "hard-cap";

export interface ProviderAccountRuntime {
  provider: string;
  accountId: string;
  kind: ProviderAccountKind;
  inFlight: number;
  lastUsedAt?: number;
  cooldownUntil?: number;
  cooldownSource?: ProviderAccountCooldownSource;
  accountExpiresAt?: number;
  autoDisableOnExpiry?: boolean;
  disabled: boolean;
  disabledReason?: ProviderAccountDisabledReason;
  selectable: boolean;
}

function oauthCooldown(
  provider: OauthRuntimeProvider,
  accountId: string,
  now: number,
): { cooldownUntil?: number; cooldownSource?: ProviderAccountCooldownSource } {
  const snap = provider === "anthropic"
    ? getAnthropicAccountHealthSnapshot(accountId, now)
    : provider === "cursor"
      ? getCursorAccountHealthSnapshot(accountId, now)
      : getGoogleAntigravityAccountHealthSnapshot(accountId, now);
  if (!snap?.cooldownUntil) return {};
  return {
    cooldownUntil: snap.cooldownUntil,
    cooldownSource: snap.cooldownSource === "retry-after" ? "retry-after" : "default",
  };
}

function oauthAffinityLastUsed(provider: OauthRuntimeProvider, accountId: string): number | undefined {
  return provider === "anthropic"
    ? getAnthropicAccountLastUsedAt(accountId)
    : provider === "cursor"
      ? getCursorAccountLastUsedAt(accountId)
      : getGoogleAntigravityAccountLastUsedAt(accountId);
}

function disabledReasonFor(account: ProviderAccount, now: number): ProviderAccountDisabledReason | undefined {
  if (account.needsReauth === true) return "needs_reauth";
  if (isAccountDisabledForRouting(account, now)) return "expired";
  return undefined;
}

export function runtimeForOAuthAccount(
  provider: OauthRuntimeProvider,
  account: ProviderAccount,
  now = Date.now(),
): ProviderAccountRuntime {
  const occ = getProviderAccountOccupancy("oauth", provider, account.id);
  const affinity = oauthAffinityLastUsed(provider, account.id);
  const lastUsedAt = Math.max(occ.lastUsedAt ?? 0, affinity ?? 0) || undefined;
  const reason = disabledReasonFor(account, now);
  return {
    provider,
    accountId: account.id,
    kind: "oauth",
    inFlight: occ.inFlight,
    ...(lastUsedAt ? { lastUsedAt } : {}),
    ...oauthCooldown(provider, account.id, now),
    ...(typeof account.accountExpiresAt === "number" ? { accountExpiresAt: account.accountExpiresAt } : {}),
    ...(account.autoDisableOnExpiry ? { autoDisableOnExpiry: true } : {}),
    disabled: reason !== undefined,
    ...(reason ? { disabledReason: reason } : {}),
    selectable: isProviderAccountSelectable(account, now),
  };
}

export function runtimeForKeyPoolEntry(
  provider: string,
  keyId: string,
  now = Date.now(),
): ProviderAccountRuntime {
  const occ = getProviderAccountOccupancy("key-pool", provider, keyId);
  const cooldownUntil = getKeyCooldownUntil(provider, keyId, now) ?? undefined;
  return {
    provider,
    accountId: keyId,
    kind: "key-pool",
    inFlight: occ.inFlight,
    ...(occ.lastUsedAt ? { lastUsedAt: occ.lastUsedAt } : {}),
    ...(cooldownUntil ? { cooldownUntil, cooldownSource: "retry-after" } : {}),
    disabled: false,
    selectable: cooldownUntil === undefined,
  };
}

export function collectProviderAccountRuntimes(
  config: OcxConfig,
  now = Date.now(),
): ProviderAccountRuntime[] {
  const rows: ProviderAccountRuntime[] = [];
  const store = loadAuthStore();
  for (const provider of OAUTH_RUNTIME_PROVIDERS) {
    const set = store[provider];
    if (!set) continue;
    for (const account of set.accounts) {
      rows.push(runtimeForOAuthAccount(provider, account, now));
    }
  }
  for (const name of Object.keys(config.providers)) {
    const listed = listProviderApiKeys(config, name);
    if (listed.keys.length < 2) continue;
    for (const key of listed.keys) {
      rows.push(runtimeForKeyPoolEntry(name, key.id, now));
    }
  }
  return rows;
}

export function oauthAccountRuntimeFields(
  provider: string,
  accountId: string,
  now = Date.now(),
): Pick<ProviderAccountRuntime, "inFlight" | "lastUsedAt" | "cooldownUntil" | "cooldownSource" | "disabled" | "disabledReason" | "selectable"> | null {
  if (!isOauthRuntimeProvider(provider)) return null;
  const account = listAccounts(provider).find(row => row.id === accountId);
  if (!account) return null;
  const runtime = runtimeForOAuthAccount(provider, account, now);
  return {
    inFlight: runtime.inFlight,
    ...(runtime.lastUsedAt ? { lastUsedAt: runtime.lastUsedAt } : {}),
    ...(runtime.cooldownUntil ? { cooldownUntil: runtime.cooldownUntil, cooldownSource: runtime.cooldownSource } : {}),
    disabled: runtime.disabled,
    ...(runtime.disabledReason ? { disabledReason: runtime.disabledReason } : {}),
    selectable: runtime.selectable,
  };
}
