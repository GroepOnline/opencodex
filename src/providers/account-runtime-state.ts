/**
 * Process-local lastUsed + inFlight for OAuth accounts and API-key pool entries.
 * Cooldown remains owned by the routing / key-failover maps; this module only
 * tracks request occupancy so health can stay one shape.
 */
export type ProviderAccountKind = "oauth" | "key-pool";

interface Occupancy {
  lastUsedAt: number;
  inFlight: number;
}

const occupancy = new Map<string, Occupancy>();

function occupancyKey(kind: ProviderAccountKind, provider: string, accountId: string): string {
  return `${kind}\0${provider}\0${accountId}`;
}

function occupancyEntry(kind: ProviderAccountKind, provider: string, accountId: string): Occupancy {
  const key = occupancyKey(kind, provider, accountId);
  let entry = occupancy.get(key);
  if (!entry) {
    entry = { lastUsedAt: 0, inFlight: 0 };
    occupancy.set(key, entry);
  }
  return entry;
}

export function noteProviderAccountUsed(
  kind: ProviderAccountKind,
  provider: string,
  accountId: string,
  now = Date.now(),
): void {
  if (!provider || !accountId) return;
  const entry = occupancyEntry(kind, provider, accountId);
  if (now > entry.lastUsedAt) entry.lastUsedAt = now;
}

export function beginProviderAccountRequest(
  kind: ProviderAccountKind,
  provider: string,
  accountId: string,
  now = Date.now(),
): void {
  if (!provider || !accountId) return;
  const entry = occupancyEntry(kind, provider, accountId);
  entry.inFlight += 1;
  if (now > entry.lastUsedAt) entry.lastUsedAt = now;
}

export function endProviderAccountRequest(
  kind: ProviderAccountKind,
  provider: string,
  accountId: string,
): void {
  if (!provider || !accountId) return;
  const key = occupancyKey(kind, provider, accountId);
  const entry = occupancy.get(key);
  if (!entry) return;
  entry.inFlight = Math.max(0, entry.inFlight - 1);
  if (entry.inFlight === 0 && entry.lastUsedAt === 0) occupancy.delete(key);
}

export function getProviderAccountOccupancy(
  kind: ProviderAccountKind,
  provider: string,
  accountId: string,
): { lastUsedAt?: number; inFlight: number } {
  const entry = occupancy.get(occupancyKey(kind, provider, accountId));
  if (!entry) return { inFlight: 0 };
  return {
    inFlight: entry.inFlight,
    ...(entry.lastUsedAt > 0 ? { lastUsedAt: entry.lastUsedAt } : {}),
  };
}

/** Test helper. */
export function clearProviderAccountRuntimeState(): void {
  occupancy.clear();
}

export type RequestAccountBinding = {
  providerAccountId?: string;
  providerAccountKind?: ProviderAccountKind;
  providerAccountProvider?: string;
};

export function bindRequestProviderAccount(
  ctx: RequestAccountBinding,
  kind: ProviderAccountKind,
  provider: string,
  accountId: string,
  now = Date.now(),
): void {
  if (!provider || !accountId) return;
  if (
    ctx.providerAccountId
    && ctx.providerAccountKind
    && ctx.providerAccountProvider
    && (ctx.providerAccountId !== accountId
      || ctx.providerAccountKind !== kind
      || ctx.providerAccountProvider !== provider)
  ) {
    endProviderAccountRequest(ctx.providerAccountKind, ctx.providerAccountProvider, ctx.providerAccountId);
  } else if (
    ctx.providerAccountId === accountId
    && ctx.providerAccountKind === kind
    && ctx.providerAccountProvider === provider
  ) {
    noteProviderAccountUsed(kind, provider, accountId, now);
    return;
  }
  ctx.providerAccountKind = kind;
  ctx.providerAccountProvider = provider;
  ctx.providerAccountId = accountId;
  beginProviderAccountRequest(kind, provider, accountId, now);
}

export function releaseRequestProviderAccount(ctx: RequestAccountBinding): void {
  if (!ctx.providerAccountId || !ctx.providerAccountKind || !ctx.providerAccountProvider) return;
  endProviderAccountRequest(ctx.providerAccountKind, ctx.providerAccountProvider, ctx.providerAccountId);
  delete ctx.providerAccountId;
  delete ctx.providerAccountKind;
  delete ctx.providerAccountProvider;
}
