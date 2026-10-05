import { getAccountRuntime, persistAccountAuthFailed, persistAccountHealthy } from "../accounts/runtime";

const CODEX_PROVIDER = "codex";
const reauthAccounts = new Set<string>();

export function markAccountNeedsReauth(id: string): void {
  reauthAccounts.add(id);
  persistAccountAuthFailed({ provider: CODEX_PROVIDER, accountId: id, reason: "refresh_failed" });
}

/** Hydrate-only: restore the Set without writing the ledger again. */
export function hydrateAccountNeedsReauth(id: string): void {
  reauthAccounts.add(id);
}

export function isAccountNeedsReauth(id: string): boolean {
  return reauthAccounts.has(id);
}

export function clearAccountNeedsReauth(id: string): void {
  reauthAccounts.delete(id);
  if (getAccountRuntime(CODEX_PROVIDER, id)?.state === "AUTH_FAILED") {
    persistAccountHealthy(CODEX_PROVIDER, id);
  }
}

/** Drop the in-memory Set without touching the ledger (process-restart tests). */
export function resetAccountNeedsReauthMemoryForTests(): void {
  reauthAccounts.clear();
}
