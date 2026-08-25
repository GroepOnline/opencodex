import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  applyExpiryDisableToAccount,
  demoteExpiryDisabledActiveAccount,
  isAccountExpired,
  isAccountDisabledForRouting,
  isProviderAccountSelectable,
  shouldAutoDisableExpiredAccount,
  shouldDemoteExpiryDisabledActiveAccount,
} from "../src/oauth/account-expiry";
import { getValidAccessToken, OAuthAccountDisabledError } from "../src/oauth";
import {
  applyExpiredAccountDisables,
  getAccountSet,
  saveCredential,
  setAccountExpiryPolicy,
  setActiveAccount,
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
import { findKeyPoolEntryId } from "../src/providers/api-keys";

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
    bindRequestProviderAccount(ctx, "oauth", "anthropic", "aaaa1111", 15);
    expect(getProviderAccountOccupancy("oauth", "anthropic", "aaaa1111")).toEqual({
      inFlight: 1,
      lastUsedAt: 15,
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

  test("key-pool bind tracks occupancy under the store id, not the secret", () => {
    const ctx: Parameters<typeof bindRequestProviderAccount>[0] = {};
    bindRequestProviderAccount(ctx, "key-pool", "openai", "k1a2b3c4", 30);
    expect(ctx.providerAccountId).toBe("k1a2b3c4");
    expect(ctx.providerAccountKind).toBe("key-pool");
    expect(getProviderAccountOccupancy("key-pool", "openai", "k1a2b3c4")).toEqual({
      inFlight: 1,
      lastUsedAt: 30,
    });
    releaseRequestProviderAccount(ctx);
    expect(getProviderAccountOccupancy("key-pool", "openai", "k1a2b3c4").inFlight).toBe(0);
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
    expect(await setActiveAccount("anthropic", liveId)).toBe(true);
    expect(await setAccountExpiryPolicy("anthropic", oldId, {
      accountExpiresAt: Date.now() - 1_000,
      autoDisableOnExpiry: true,
    })).toBe(true);
    expect(getAccountSet("anthropic")?.accounts.find(row => row.id === oldId)?.disabledByExpiry).toBe(true);
    expect(getAccountSet("anthropic")?.activeAccountId).toBe(liveId);
    expect(getEligibleAnthropicAccounts().sort()).toEqual([liveId]);
    await expect(getValidAccessToken("anthropic")).resolves.toBe("access-1");
    const runtime = runtimeForOAuthAccount("anthropic", getAccountSet("anthropic")!.accounts.find(row => row.id === oldId)!);
    expect(runtime.disabled).toBe(true);
    expect(runtime.disabledReason).toBe("expired");
    expect(runtime.selectable).toBe(false);
  });

  test("latching the active seat demotes to a selectable same-provider sibling", async () => {
    await saveCredential("anthropic", cred({ email: "live@example.com", accountId: "live" }));
    await saveCredential("anthropic", cred({ email: "old@example.com", accountId: "old" }));
    await saveCredential("cursor", cred({ email: "cursor@example.com", accountId: "cursor-live" }));
    const anthropic = getAccountSet("anthropic")!;
    const liveId = anthropic.accounts.find(row => row.credential.email === "live@example.com")!.id;
    const oldId = anthropic.accounts.find(row => row.credential.email === "old@example.com")!.id;
    const cursorActive = getAccountSet("cursor")!.activeAccountId;
    expect(await setActiveAccount("anthropic", oldId)).toBe(true);
    expect(await setAccountExpiryPolicy("anthropic", oldId, {
      accountExpiresAt: Date.now() - 1_000,
      autoDisableOnExpiry: true,
    })).toBe(true);
    expect(getAccountSet("anthropic")?.activeAccountId).toBe(liveId);
    expect(getAccountSet("cursor")?.activeAccountId).toBe(cursorActive);
    await expect(getValidAccessToken("anthropic")).resolves.toBe("access-1");
  });

  test("does not demote when no selectable sibling exists", async () => {
    await saveCredential("anthropic", cred({ email: "only@example.com", accountId: "only" }));
    const onlyId = getAccountSet("anthropic")!.activeAccountId;
    expect(await setAccountExpiryPolicy("anthropic", onlyId, {
      accountExpiresAt: Date.now() - 1_000,
      autoDisableOnExpiry: true,
    })).toBe(true);
    expect(getAccountSet("anthropic")?.activeAccountId).toBe(onlyId);
    await expect(getValidAccessToken("anthropic")).rejects.toBeInstanceOf(OAuthAccountDisabledError);
  });

  test("does not demote across providers when the only sibling is on another provider", async () => {
    await saveCredential("anthropic", cred({ email: "old@example.com", accountId: "old" }));
    await saveCredential("cursor", cred({ email: "cursor@example.com", accountId: "cursor-live" }));
    const anthropicId = getAccountSet("anthropic")!.activeAccountId;
    const cursorId = getAccountSet("cursor")!.activeAccountId;
    expect(await setAccountExpiryPolicy("anthropic", anthropicId, {
      accountExpiresAt: Date.now() - 1_000,
      autoDisableOnExpiry: true,
    })).toBe(true);
    expect(getAccountSet("anthropic")?.activeAccountId).toBe(anthropicId);
    expect(getAccountSet("cursor")?.activeAccountId).toBe(cursorId);
    expect(shouldDemoteExpiryDisabledActiveAccount(getAccountSet("anthropic")!)).toBe(false);
  });

  test("needsReauth on the active seat does not trigger expiry demote", () => {
    const set = {
      activeAccountId: "a",
      accounts: [
        account({ id: "a", needsReauth: true }),
        account({ id: "b" }),
      ],
    };
    expect(demoteExpiryDisabledActiveAccount(set)).toBe(false);
    expect(set.activeAccountId).toBe("a");
  });

  test("turning off autoDisableOnExpiry clears a latched seat", async () => {
    await saveCredential("anthropic", cred({ email: "old@example.com", accountId: "old" }));
    const id = getAccountSet("anthropic")!.activeAccountId;
    expect(await setAccountExpiryPolicy("anthropic", id, {
      accountExpiresAt: Date.now() - 1_000,
      autoDisableOnExpiry: true,
    })).toBe(true);
    expect(getAccountSet("anthropic")?.accounts[0]?.disabledByExpiry).toBe(true);
    expect(await setAccountExpiryPolicy("anthropic", id, { autoDisableOnExpiry: false })).toBe(true);
    const row = getAccountSet("anthropic")!.accounts[0]!;
    expect(row.disabledByExpiry).toBeUndefined();
    expect(row.autoDisableOnExpiry).toBeUndefined();
    expect(isProviderAccountSelectable(row)).toBe(true);
  });

  test("request-time token snapshot latches and demotes before resolving sibling", async () => {
    await saveCredential("anthropic", cred({ email: "live@example.com", accountId: "live" }));
    await saveCredential("anthropic", cred({ email: "old@example.com", accountId: "old" }));
    const set = getAccountSet("anthropic")!;
    const liveId = set.accounts.find(row => row.credential.email === "live@example.com")!.id;
    const oldId = set.accounts.find(row => row.credential.email === "old@example.com")!.id;
    expect(await setActiveAccount("anthropic", oldId)).toBe(true);
    expect(await setAccountExpiryPolicy("anthropic", oldId, {
      accountExpiresAt: 5_000,
      autoDisableOnExpiry: true,
    }, 1_000)).toBe(true);
    expect(getAccountSet("anthropic")?.activeAccountId).toBe(oldId);
    expect(getAccountSet("anthropic")?.accounts.find(row => row.id === oldId)?.disabledByExpiry).toBeUndefined();

    await expect(getValidAccessToken("anthropic")).resolves.toBe("access-1");
    expect(getAccountSet("anthropic")?.accounts.find(row => row.id === oldId)?.disabledByExpiry).toBe(true);
    expect(getAccountSet("anthropic")?.activeAccountId).toBe(liveId);
  });

  test("applyExpiredAccountDisables is a no-op when nothing is due", async () => {
    await saveCredential("anthropic", cred({ email: "a@example.com", accountId: "a" }));
    expect(await applyExpiredAccountDisables()).toBe(0);
  });

  test("applyExpiredAccountDisables latches and demotes the active seat", async () => {
    await saveCredential("anthropic", cred({ email: "live@example.com", accountId: "live" }));
    await saveCredential("anthropic", cred({ email: "old@example.com", accountId: "old" }));
    const set = getAccountSet("anthropic")!;
    const liveId = set.accounts.find(row => row.credential.email === "live@example.com")!.id;
    const oldId = set.accounts.find(row => row.credential.email === "old@example.com")!.id;
    expect(await setActiveAccount("anthropic", oldId)).toBe(true);
    expect(await setAccountExpiryPolicy("anthropic", oldId, {
      accountExpiresAt: 5_000,
      autoDisableOnExpiry: true,
    }, 1_000)).toBe(true);
    expect(getAccountSet("anthropic")?.accounts.find(row => row.id === oldId)?.disabledByExpiry).toBeUndefined();
    expect(await applyExpiredAccountDisables(6_000)).toBe(1);
    expect(getAccountSet("anthropic")?.accounts.find(row => row.id === oldId)?.disabledByExpiry).toBe(true);
    expect(getAccountSet("anthropic")?.activeAccountId).toBe(liveId);
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

describe("findKeyPoolEntryId", () => {
  test("returns the stored pool id and never the secret", () => {
    // Placeholder token shape is constrained by scripts/privacy-scan.ts's tests/ allowlist.
    const secret = "sk-test-000111222333444";
    const other = "sk-test-000222333444555";
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      apiKey: secret,
      apiKeyPool: [
        { id: "k1a2b3c4", key: secret },
        { id: "k2b3c4d5", key: other },
      ],
    } as OcxConfig["providers"][string];
    expect(findKeyPoolEntryId(provider, secret)).toBe("k1a2b3c4");
    expect(findKeyPoolEntryId(provider)).toBe("k1a2b3c4");
    expect(findKeyPoolEntryId(provider, other)).toBe("k2b3c4d5");
    expect(findKeyPoolEntryId({ ...provider, authMode: "oauth" }, secret)).toBeUndefined();
    expect(findKeyPoolEntryId(provider, secret)).not.toBe(secret);
    expect(findKeyPoolEntryId(provider, other)).not.toBe(other);
  });
});
