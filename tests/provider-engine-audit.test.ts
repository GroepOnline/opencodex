import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markAccountNeedsReauth, isAccountNeedsReauth, clearAccountNeedsReauth } from "../src/codex/account-runtime-state";
import {
  clearPoolRotationState,
  pickRoundRobinAccount,
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
  clearAccountNeedsReauth("codex-audit");
});

afterEach(() => {
  clearGoogleAntigravityAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache(PROVIDER);
  clearKeyCooldowns();
  clearAccountNeedsReauth("codex-audit");
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

describe("provider engine audit — persistence", () => {
  test("API-key 429 cooldown is process-local and never written to disk", () => {
    const now = 1_000_000;
    rotateKeyOn429(keyConfig(), "p", "30", now);
    expect(getKeyCooldownUntil("p", "k1", now)).toBe(now + 30_000);
    expect(diskRuntimeArtifacts()).toEqual([]);
    clearKeyCooldowns();
    expect(getKeyCooldownUntil("p", "k1", now)).toBeNull();
  });

  test("Antigravity pool cooldown and RR cursor are process-local", async () => {
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

    pickRoundRobinAccount(POOL_KEY_ANTIGRAVITY, [firstId, secondId], 1);
    expect(peekRoundRobinAccount(POOL_KEY_ANTIGRAVITY, [firstId, secondId], 1)).not.toBeNull();
    expect(diskRuntimeArtifacts()).toEqual([]);

    clearGoogleAntigravityAccountPoolState();
    clearPoolRotationState(POOL_KEY_ANTIGRAVITY);
    expect(getGoogleAntigravityAccountHealthSnapshot(firstId, now)).toBeNull();
  });

  test("Codex needsReauth is an in-memory Set with no persist path", () => {
    markAccountNeedsReauth("codex-audit");
    expect(isAccountNeedsReauth("codex-audit")).toBe(true);
    expect(diskRuntimeArtifacts()).toEqual([]);
    clearAccountNeedsReauth("codex-audit");
    expect(isAccountNeedsReauth("codex-audit")).toBe(false);
  });
});

describe("provider engine audit — Antigravity quota scoring", () => {
  // parseAntigravityModelsQuota only writes customWindows (Gem/Cla). usageScore()
  // reads fiveHourPercent, so live Antigravity probes never inform quota pick.
  test("customWindows-only quota is treated as unknown, so quota pick stays on active", async () => {
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
    expect(selection).toEqual({ accountId: activeId, reason: "active" });
    expect(selection.accountId).not.toBe(otherId);
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
