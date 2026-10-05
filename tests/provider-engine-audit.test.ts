import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydrateAccountRuntimeFromDisk } from "../src/accounts/hydrate";
import { getAccountRuntime, getAccountRuntimePath, resetAccountRuntimeCacheForTests } from "../src/accounts/runtime";
import {
  markAccountNeedsReauth,
  isAccountNeedsReauth,
  clearAccountNeedsReauth,
  resetAccountNeedsReauthMemoryForTests,
} from "../src/codex/account-runtime-state";
import { clearCodexUpstreamHealth } from "../src/codex/routing";
import {
  clearPoolRotationState,
  peekRoundRobinAccount,
  POOL_KEY_ANTIGRAVITY,
} from "../src/codex/pool-rotation";
import { getConfigDir } from "../src/config";
import {
  clearGoogleAntigravityAccountPoolState,
  getGoogleAntigravityAccountHealthSnapshot,
  resolveGoogleAntigravityAccountForSession,
  rotateGoogleAntigravityAccountOn429,
} from "../src/oauth/google-antigravity-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import { appendUsageEntry, readUsageEntries, usageLogPath } from "../src/usage/log";
import { providerAccountLabel } from "../src/providers/label";
import { clearKeyCooldowns, getKeyCooldownUntil, rotateKeyOn429 } from "../src/providers/key-failover";
import {
  clearAccountQuotaCache,
  setCachedProviderAccountQuotaForTests,
} from "../src/providers/quota";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const PROVIDER = "google-antigravity";
const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-engine-audit-"));
  process.env.OPENCODEX_HOME = home;
  clearGoogleAntigravityAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache(PROVIDER);
  clearKeyCooldowns();
  clearCodexUpstreamHealth();
  resetAccountNeedsReauthMemoryForTests();
  resetAccountRuntimeCacheForTests();
});

afterEach(() => {
  clearGoogleAntigravityAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache(PROVIDER);
  clearKeyCooldowns();
  clearCodexUpstreamHealth();
  resetAccountNeedsReauthMemoryForTests();
  resetAccountRuntimeCacheForTests();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function antigravityConfig(strategy: "quota" | "round-robin" = "quota"): OcxConfig {
  return {
    port: 0,
    defaultProvider: PROVIDER,
    providers: {
      [PROVIDER]: {
        adapter: "google",
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
        authMode: "oauth",
        googleMode: "cloud-code-assist",
      },
    },
    googleAntigravityAccountPool: { enabled: true, autoSwitchThreshold: 80, strategy },
  };
}

function keyConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "p",
    providers: {
      p: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        apiKey: "key-alpha-000111222333",
        apiKeyPool: [
          { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
          { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
        ],
      } as OcxProviderConfig,
    },
  };
}

async function seedAntigravityAccounts(): Promise<[string, string]> {
  await saveCredential(PROVIDER, {
    access: "access-a",
    refresh: "refresh-a",
    expires: Date.now() + 3_600_000,
    accountId: "account-a",
    email: "a@example.test",
    projectId: "project-a",
  });
  await saveCredential(PROVIDER, {
    access: "access-b",
    refresh: "refresh-b",
    expires: Date.now() + 3_600_000,
    accountId: "account-b",
    email: "b@example.test",
    projectId: "project-b",
  });
  const ids = getAccountSet(PROVIDER)!.accounts.map(account => account.id);
  await setActiveAccount(PROVIDER, ids[0]!);
  return [ids[0]!, ids[1]!];
}

function diskRuntimeArtifacts(): string[] {
  if (!existsSync(getConfigDir())) return [];
  return readdirSync(getConfigDir()).filter(name =>
    /rotation|cooldown|runtime-health|account-state/i.test(name),
  );
}

function simulateProcessRestart(now?: number): void {
  clearGoogleAntigravityAccountPoolState();
  clearPoolRotationState();
  clearKeyCooldowns();
  clearCodexUpstreamHealth();
  resetAccountNeedsReauthMemoryForTests();
  resetAccountRuntimeCacheForTests();
  hydrateAccountRuntimeFromDisk(now);
}

describe("provider engine audit — persistence", () => {
  test("API-key 429 cooldown is written through and still cooled after reload", () => {
    const now = 1_000_000;
    rotateKeyOn429(keyConfig(), "p", "30", now);
    expect(getKeyCooldownUntil("p", "k1", now)).toBe(now + 30_000);
    expect(existsSync(getAccountRuntimePath())).toBe(true);
    expect(getAccountRuntime("key:p", "k1", now)?.state).toBe("RATE_LIMITED");
    simulateProcessRestart(now);
    expect(getKeyCooldownUntil("p", "k1", now)).toBe(now + 30_000);
  });

  test("Antigravity pool cooldown and RR cursor survive reload", async () => {
    const [firstId, secondId] = await seedAntigravityAccounts();
    const now = 2_000_000;
    expect(rotateGoogleAntigravityAccountOn429(
      antigravityConfig("round-robin"),
      firstId,
      "45",
      "sess",
      now,
    )).toBe(secondId);
    expect(getGoogleAntigravityAccountHealthSnapshot(firstId, now)?.cooldownUntil).toBe(now + 45_000);
    expect(getAccountRuntime(PROVIDER, firstId, now)?.state).toBe("RATE_LIMITED");

    expect(resolveGoogleAntigravityAccountForSession(
      "fresh-session",
      antigravityConfig("round-robin"),
      now,
    ).accountId).not.toBe(firstId);
    const nextBeforeRestart = peekRoundRobinAccount(POOL_KEY_ANTIGRAVITY, [secondId], 1);
    expect(nextBeforeRestart).toBe(secondId);
    expect(diskRuntimeArtifacts()).toEqual([]);

    simulateProcessRestart(now);
    expect(getGoogleAntigravityAccountHealthSnapshot(firstId, now)?.cooldownUntil).toBe(now + 45_000);
    expect(existsSync(getAccountRuntimePath())).toBe(true);
    expect(peekRoundRobinAccount(POOL_KEY_ANTIGRAVITY, [secondId], 1)).toBe(nextBeforeRestart);
    expect(resolveGoogleAntigravityAccountForSession(
      "fresh-session",
      antigravityConfig("round-robin"),
      now,
    ).accountId).not.toBe(firstId);
  });

  test("Codex AUTH_FAILED is written through and still failed after reload", () => {
    markAccountNeedsReauth("codex-audit");
    expect(isAccountNeedsReauth("codex-audit")).toBe(true);
    expect(getAccountRuntime("codex", "codex-audit")?.state).toBe("AUTH_FAILED");
    simulateProcessRestart();
    expect(isAccountNeedsReauth("codex-audit")).toBe(true);
    clearAccountNeedsReauth("codex-audit");
    expect(isAccountNeedsReauth("codex-audit")).toBe(false);
  });
});

describe("provider engine audit — Antigravity quota scoring", () => {
  test("customWindows-only quota informs quota pick via max(Gem/Cla)", async () => {
    const [activeId, otherId] = await seedAntigravityAccounts();
    setCachedProviderAccountQuotaForTests(PROVIDER, activeId, {
      customWindows: [{ label: "Gem", percent: 99, resetAt: Date.now() + 3_600_000 }],
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests(PROVIDER, otherId, {
      customWindows: [{ label: "Gem", percent: 4, resetAt: Date.now() + 3_600_000 }],
      updatedAt: Date.now(),
    });

    const selection = resolveGoogleAntigravityAccountForSession(
      "new-session",
      antigravityConfig("quota"),
    );
    expect(selection).toEqual({ accountId: otherId, reason: "lowest-usage" });
    expect(selection.accountId).not.toBe(activeId);
  });
});

describe("provider engine audit — usage account attribution", () => {
  test("appendUsageEntry stores account only when the provider label carries a pool suffix", () => {
    appendUsageEntry({
      requestId: "ocx-audit-1",
      timestamp: 1,
      provider: "google-antigravity",
      model: "gemini-3.6-flash",
      status: 200,
      durationMs: 10,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const rows = readUsageEntries();
    expect(usageLogPath()).toBe(join(home, "usage.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.account).toBeUndefined();
    expect(providerAccountLabel("google-antigravity")).toBeUndefined();
    expect(providerAccountLabel("google-antigravity-pabc123")).toBe("pabc123");
  });
});
