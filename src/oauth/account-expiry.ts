import type { ProviderAccount, ProviderAccountSet } from "./types";

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

function selectableSiblingForExpiryDemote(
  set: Pick<ProviderAccountSet, "activeAccountId" | "accounts">,
  now: number,
): ProviderAccount | undefined {
  const active = set.accounts.find(account => account.id === set.activeAccountId);
  if (!active) return undefined;
  const activeDisabled = isAccountDisabledForRouting(active, now)
    || shouldAutoDisableExpiredAccount(active, now);
  if (!activeDisabled) return undefined;
  return set.accounts.find(
    account => account.id !== active.id && isProviderAccountSelectable(account, now),
  );
}

/** True when a same-provider selectable sibling can replace an expiry-disabled active seat. */
export function shouldDemoteExpiryDisabledActiveAccount(
  set: Pick<ProviderAccountSet, "activeAccountId" | "accounts">,
  now = Date.now(),
): boolean {
  return selectableSiblingForExpiryDemote(set, now) !== undefined;
}

/**
 * Same-provider only: when the active seat is expiry-disabled and another
 * selectable sibling exists, make that sibling active. Never inspects other
 * providers — this is not cross-provider routing.
 */
export function demoteExpiryDisabledActiveAccount(
  set: ProviderAccountSet,
  now = Date.now(),
): boolean {
  const sibling = selectableSiblingForExpiryDemote(set, now);
  if (!sibling) return false;
  set.activeAccountId = sibling.id;
  return true;
}
