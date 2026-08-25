import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  applyExpiryDisableToAccount,
  isAccountExpired,
  isAccountDisabledForRouting,
  isProviderAccountSelectable,
  shouldAutoDisableExpiredAccount,
} from "../src/oauth/account-expiry";
import { getValidAccessToken, OAuthAccountDisabledError } from "../src/oauth";
import {
  applyExpiredAccountDisables,
  getAccountSet,
  saveCredential,
  setAccountExpiryPolicy,
} from "../src/oauth/store";
import type { OAuthCredentials, ProviderAccount } from "../src/oauth/types";
import { getEligibleAnthropicAccounts } from "../src/oauth/anthropic-routing";
import {
  bindRequestProviderAccount,
  clearProviderAccountRuntimeState,
  collectProviderAccountRuntimes,
  getProviderAccountOccupancy,
  releaseRequestProviderAccount,
  runtimeForOAuthAccount,
} from "../src/providers/account-runtime";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-account-runtime-test");
let previousHome: string | undefined;

const cred = (over: Partial<OAuthCredentials> = {}): OAuthCredentials => ({
  access: "access-1",
  refresh: "refresh-1",
  expires: Date.now() + 3600_000,
  ...over,
});

function account(over: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: "acct1",
    credential: cred(),
    ...over,
  };
}

describe("account expiry", () => {
  test("seat expiry is distinct from credential.expires", () => {
    const now = 1_000;
    const row = account({
      credential: cred({ expires: 500 }),
      accountExpiresAt: 2_000,
    });
    expect(isAccountExpired(row, now)).toBe(false);
    expect(isAccountExpired({ accountExpiresAt: 1_000 }, now)).toBe(true);
    expect(isAccountExpired({ accountExpiresAt: 999 }, now)).toBe(true);
  });

  test("auto-disable only fires when the operator opted in", () => {
    const now = 5_000;
    const expired = account({ accountExpiresAt: 1 });
    expect(shouldAutoDisableExpiredAccount(expired, now)).toBe(false);
    expect(isProviderAccountSelectable(expired, now)).toBe(true);
    expired.autoDisableOnExpiry = true;
    expect(shouldAutoDisableExpiredAccount(expired, now)).toBe(true);
    expect(isAccountDisabledForRouting(expired, now)).toBe(true);
    expect(isProviderAccountSelectable(expired, now)).toBe(false);
    expect(applyExpiryDisableToAccount(expired, now)).toBe(true);
    expect(expired.disabledByExpiry).toBe(true);
    expect(applyExpiryDisableToAccount(expired, now)).toBe(false);
  });
});

describe("provider account occupancy", () => {
  beforeEach(() => {
    clearProviderAccountRuntimeState();
  });

  afterEach(() => {
    clearProviderAccountRuntimeState();
  });

  test("bind/rebind/release tracks inFlight and lastUsed", () => {
    const ctx: Parameters<typeof bindRequestProviderAccount>[0] = {};
    bindRequestProviderAccount(ctx, "oauth", "anthropic", "aaaa1111", 10);
    expect(ctx.providerAccountId).toBe("aaaa1111");
    expect(getProviderAccountOccupancy("oauth", "anthropic", "aaaa1111")).toEqual({
      inFlight: 1,
      lastUsedAt: 10,
    });
    bindRequestProviderAccount(ctx, "oauth", "anthropic", "bbbb2222", 20);
    expect(getProviderAccountOccupancy("oauth", "anthropic", "aaaa1111").inFlight).toBe(0);
    expect(getProviderAccountOccupancy("oauth", "anthropic", "bbbb2222")).toEqual({
      inFlight: 1,
      lastUsedAt: 20,
    });
    releaseRequestProviderAccount(ctx);
    expect(ctx.providerAccountId).toBeUndefined();
    expect(getProviderAccountOccupancy("oauth", "anthropic", "bbbb2222").inFlight).toBe(0);
  });
});

describe("store expiry policy + routing", () => {
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearProviderAccountRuntimeState();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    clearProviderAccountRuntimeState();
  });

  test("expired auto-disable accounts drop out of the Anthropic pool", async () => {
    await saveCredential("anthropic", cred({ email: "live@example.com", accountId: "live" }));
    await saveCredential("anthropic", cred({ email: "old@example.com", accountId: "old" }));
    const set = getAccountSet("anthropic")!;
    const liveId = set.accounts.find(row => row.credential.email === "live@example.com")!.id;
    const oldId = set.accounts.find(row => row.credential.email === "old@example.com")!.id;
    expect(await setAccountExpiryPolicy("anthropic", oldId, {
      accountExpiresAt: Date.now() - 1_000,
      autoDisableOnExpiry: true,
    })).toBe(true);
    expect(getAccountSet("anthropic")?.accounts.find(row => row.id === oldId)?.disabledByExpiry).toBe(true);
    expect(getEligibleAnthropicAccounts().sort()).toEqual([liveId]);
    await expect(getValidAccessToken("anthropic")).rejects.toBeInstanceOf(OAuthAccountDisabledError);
    const runtime = runtimeForOAuthAccount("anthropic", getAccountSet("anthropic")!.accounts.find(row => row.id === oldId)!);
    expect(runtime.disabled).toBe(true);
    expect(runtime.disabledReason).toBe("expired");
    expect(runtime.selectable).toBe(false);
  });

  test("applyExpiredAccountDisables is a no-op when nothing is due", async () => {
    await saveCredential("anthropic", cred({ email: "a@example.com", accountId: "a" }));
    expect(await applyExpiredAccountDisables()).toBe(0);
  });

  test("collectProviderAccountRuntimes includes OAuth rows", async () => {
    await saveCredential("anthropic", cred({ email: "a@example.com", accountId: "a" }));
    const config = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "anthropic",
      providers: {
        anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
      },
    } as OcxConfig;
    const rows = collectProviderAccountRuntimes(config);
    expect(rows.some(row => row.provider === "anthropic" && row.kind === "oauth")).toBe(true);
  });
});
