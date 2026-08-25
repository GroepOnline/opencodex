import type { ProviderAccount } from "./types";

/** True when the operator-owned seat/subscription window has passed. Distinct from credential.expires. */
export function isAccountExpired(account: Pick<ProviderAccount, "accountExpiresAt">, now = Date.now()): boolean {
  return typeof account.accountExpiresAt === "number"
    && Number.isFinite(account.accountExpiresAt)
    && account.accountExpiresAt <= now;
}

/** Persistable auto-disable should fire: expired seat and the operator opted in. */
export function shouldAutoDisableExpiredAccount(
  account: Pick<ProviderAccount, "accountExpiresAt" | "autoDisableOnExpiry" | "disabledByExpiry">,
  now = Date.now(),
): boolean {
  return account.autoDisableOnExpiry === true
    && account.disabledByExpiry !== true
    && isAccountExpired(account, now);
}

/** Seat is latched disabled, or would auto-disable now. Credential token expiry is unrelated. */
export function isAccountDisabledForRouting(
  account: Pick<ProviderAccount, "accountExpiresAt" | "autoDisableOnExpiry" | "disabledByExpiry">,
  now = Date.now(),
): boolean {
  return account.disabledByExpiry === true
    || (account.autoDisableOnExpiry === true && isAccountExpired(account, now));
}

/**
 * Pool/routing eligibility. Expired+auto-disable (or already latched disabledByExpiry)
 * is not selectable. Credential token expiry stays a separate refresh concern.
 */
export function isProviderAccountSelectable(
  account: Pick<ProviderAccount, "needsReauth" | "accountExpiresAt" | "autoDisableOnExpiry" | "disabledByExpiry">,
  now = Date.now(),
): boolean {
  if (account.needsReauth === true) return false;
  if (isAccountDisabledForRouting(account, now)) return false;
  return true;
}

export function applyExpiryDisableToAccount(account: ProviderAccount, now = Date.now()): boolean {
  if (!shouldAutoDisableExpiredAccount(account, now)) return false;
  account.disabledByExpiry = true;
  return true;
}
