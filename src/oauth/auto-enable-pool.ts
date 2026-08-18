import type { OcxConfig } from "../types";
import { getAccountSet } from "./store";

export type OAuthPoolProviderId = "anthropic" | "cursor" | "google-antigravity";

export function isOAuthPoolProvider(provider: string): provider is OAuthPoolProviderId {
  return provider === "anthropic" || provider === "cursor" || provider === "google-antigravity";
}

/**
 * Turn the OAuth account pool on the first time a provider crosses from one
 * account to two. Operators can still disable it afterwards; this only fills
 * the empty opt-in, and only on that 1→2 write.
 */
export function autoEnableOAuthAccountPoolOnSecondAccount(
  config: OcxConfig,
  provider: string,
  accountCountBeforeWrite: number,
): boolean {
  if (!isOAuthPoolProvider(provider)) return false;
  if (accountCountBeforeWrite !== 1) return false;
  if ((getAccountSet(provider)?.accounts.length ?? 0) !== 2) return false;
  const field = provider === "anthropic"
    ? "anthropicAccountPool"
    : provider === "cursor"
      ? "cursorAccountPool"
      : "googleAntigravityAccountPool";
  // An explicitly persisted false is an operator choice, not an empty opt-in.
  if (config[field] !== undefined) return false;
  config[field] = { enabled: true };
  return true;
}
