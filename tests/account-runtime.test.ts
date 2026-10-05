import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydrateAccountRuntimeFromDisk } from "../src/accounts/hydrate";
import {
  getAccountRuntime,
  getAccountRuntimePath,
  persistAccountAuthFailed,
  persistAccountRuntime,
  persistPoolCooldown,
  reloadAccountRuntimeStore,
  resetAccountRuntimeCacheForTests,
  transition,
} from "../src/accounts/runtime";
import {
  clearAccountNeedsReauth,
  isAccountNeedsReauth,
  markAccountNeedsReauth,
  resetAccountNeedsReauthMemoryForTests,
} from "../src/codex/account-runtime-state";
import {
  clearPoolRotationState,
  getPoolRotationSnapshot,
  peekRoundRobinAccount,
  pickRoundRobinAccount,
  POOL_KEY_ANTIGRAVITY,
} from "../src/codex/pool-rotation";
import {
  clearCodexUpstreamHealth,
  getCodexAccountHealthSnapshot,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import {
  clearGoogleAntigravityAccountPoolState,
  getGoogleAntigravityAccountHealthSnapshot,
  resolveGoogleAntigravityAccountForSession,
  rotateGoogleAntigravityAccountOn429,
} from "../src/oauth/google-antigravity-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import { projectAccountRuntimeHealth } from "../src/oauth/health";
import { clearKeyCooldowns, getKeyCooldownUntil, rotateKeyOn429 } from "../src/providers/key-failover";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const PROVIDER = "google-antigravity";
const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-account-runtime-"));
  process.env.OPENCODEX_HOME = home;
  resetAccountRuntimeCacheForTests();
  clearGoogleAntigravityAccountPoolState();
  clearPoolRotationState();
  clearKeyCooldowns();
  clearCodexUpstreamHealth();
  resetAccountNeedsReauthMemoryForTests();
});

afterEach(() => {
  clearGoogleAntigravityAccountPoolState();
  clearPoolRotationState();
  clearKeyCooldowns();
  clearCodexUpstreamHealth();
  resetAccountNeedsReauthMemoryForTests();
  resetAccountRuntimeCacheForTests();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function simulateRestart(now?: number): void {
  clearGoogleAntigravityAccountPoolState();
  clearPoolRotationState();
  clearKeyCooldowns();
  clearCodexUpstreamHealth();
  resetAccountNeedsReauthMemoryForTests();
  resetAccountRuntimeCacheForTests();
  hydrateAccountRuntimeFromDisk(now);
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

describe("account runtime transition", () => {
  test("AUTH_FAILED only returns to HEALTHY", () => {
    expect(transition("AUTH_FAILED", "RATE_LIMITED")).toBe("AUTH_FAILED");
    expect(transition("AUTH_FAILED", "COOLDOWN")).toBe("AUTH_FAILED");
    expect(transition("AUTH_FAILED", "HEALTHY")).toBe("HEALTHY");
  });

  test("UNKNOWN accepts the first observed failure", () => {
    expect(transition(undefined, "RATE_LIMITED")).toBe("RATE_LIMITED");
    expect(transition("UNKNOWN", "AUTH_FAILED")).toBe("AUTH_FAILED");
  });
});

describe("account runtime persist + hydrate", () => {
  test("API-key 429 cooldown survives reload", () => {
    const now = 1_000_000;
    rotateKeyOn429(keyConfig(), "p", "30", now);
    expect(existsSync(getAccountRuntimePath())).toBe(true);
    expect(getAccountRuntime("key:p", "k1", now)?.state).toBe("RATE_LIMITED");
    simulateRestart(now);
    expect(getKeyCooldownUntil("p", "k1", now)).toBe(now + 30_000);
  });

  test("Antigravity pool cooldown survives reload and still projects cooldown", async () => {
    const [firstId] = await seedAntigravityAccounts();
    const now = 2_000_000;
    rotateGoogleAntigravityAccountOn429(
      {
        port: 0,
        defaultProvider: PROVIDER,
        providers: {
          [PROVIDER]: {
            adapter: "google",
            baseUrl: "https://daily-cloudcode-pa.googleapis.com",
            authMode: "oauth",
          },
        },
        googleAntigravityAccountPool: { enabled: true, strategy: "round-robin" },
      },
      firstId,
      "45",
      "sess",
      now,
    );
    const onDisk = JSON.parse(readFileSync(getAccountRuntimePath(), "utf8")) as {
      accounts: Record<string, { state: string; until?: number }>;
    };
    expect(Object.values(onDisk.accounts).some(row => row.state === "RATE_LIMITED")).toBe(true);

    simulateRestart(now);
    expect(getGoogleAntigravityAccountHealthSnapshot(firstId, now)?.cooldownUntil).toBe(now + 45_000);
    expect(projectAccountRuntimeHealth(getAccountRuntime(PROVIDER, firstId, now), now)).toEqual({
      status: "cooldown",
      until: new Date(now + 45_000).toISOString(),
      reason: "rate_limit",
    });
  });

  test("Codex AUTH_FAILED survives reload", () => {
    markAccountNeedsReauth("codex-audit");
    expect(isAccountNeedsReauth("codex-audit")).toBe(true);
    expect(getAccountRuntime("codex", "codex-audit")?.state).toBe("AUTH_FAILED");
    simulateRestart();
    expect(isAccountNeedsReauth("codex-audit")).toBe(true);
    expect(projectAccountRuntimeHealth(getAccountRuntime("codex", "codex-audit"))).toEqual({
      status: "reauth_required",
      reason: "refresh_failed",
    });
  });

  test("Codex account-wide 429 cooldown survives reload", () => {
    const now = Date.parse("2026-08-23T12:00:00.000Z");
    recordCodexUpstreamOutcome({ providers: {} } as OcxConfig, "pool-acct", 429, {
      retryAfter: "120",
      now,
    });
    simulateRestart(now);
    expect(getCodexAccountHealthSnapshot("pool-acct", now)).toEqual({
      cooldownUntil: now + 120_000,
      cooldownSource: "retry-after",
    });
  });

  test("quota-window COOLDOWN survives reload", () => {
    const now = 4_000_000;
    persistPoolCooldown({
      provider: "codex",
      accountId: "quota-acct",
      cooldownUntil: now + 60_000,
      cooldownSource: "reset-derived",
      now,
    });
    expect(getAccountRuntime("codex", "quota-acct", now)?.state).toBe("COOLDOWN");
    simulateRestart(now);
    expect(getAccountRuntime("codex", "quota-acct", now)?.state).toBe("COOLDOWN");
    expect(getCodexAccountHealthSnapshot("quota-acct", now)).toEqual({
      cooldownUntil: now + 60_000,
      cooldownSource: "reset-derived",
    });
  });

  test("AUTH_FAILED is not overwritten by a later cooldown write", () => {
    persistAccountAuthFailed({ provider: "codex", accountId: "locked", now: 10 });
    persistPoolCooldown({
      provider: "codex",
      accountId: "locked",
      cooldownUntil: 10_000,
      cooldownSource: "retry-after",
      now: 20,
    });
    expect(getAccountRuntime("codex", "locked", 20)?.state).toBe("AUTH_FAILED");
  });

  test("reloadAccountRuntimeStore re-reads disk after a cache drop", () => {
    persistAccountRuntime({
      provider: "cursor",
      accountId: "c1",
      state: "COOLDOWN",
      reason: "quota_window",
      until: Date.now() + 60_000,
    });
    resetAccountRuntimeCacheForTests();
    const reloaded = reloadAccountRuntimeStore();
    expect(Object.values(reloaded.accounts).some(row => row.accountId === "c1")).toBe(true);
  });

  test("clearAccountNeedsReauth writes HEALTHY by removing the ledger row", () => {
    markAccountNeedsReauth("codex-audit");
    clearAccountNeedsReauth("codex-audit");
    expect(getAccountRuntime("codex", "codex-audit")).toBeNull();
    simulateRestart();
    expect(isAccountNeedsReauth("codex-audit")).toBe(false);
  });

  test("RATE_LIMITED + RR cursor survive reload and do not return to the punished account", async () => {
    const [firstId, secondId] = await seedAntigravityAccounts();
    await saveCredential(PROVIDER, {
      access: "access-c",
      refresh: "refresh-c",
      expires: Date.now() + 3_600_000,
      accountId: "account-c",
      email: "c@example.test",
      projectId: "project-c",
    });
    const thirdId = getAccountSet(PROVIDER)!.accounts.map(account => account.id)
      .find(id => id !== firstId && id !== secondId)!;
    const ids = [firstId, secondId, thirdId];
    const now = 3_000_000;
    const config = {
      port: 0,
      defaultProvider: PROVIDER,
      providers: {
        [PROVIDER]: {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
        },
      },
      googleAntigravityAccountPool: { enabled: true, strategy: "round-robin" as const },
    };

    hydrateAccountRuntimeFromDisk(now);
    expect(pickRoundRobinAccount(POOL_KEY_ANTIGRAVITY, ids, 1)).toBe(firstId);
    expect(pickRoundRobinAccount(POOL_KEY_ANTIGRAVITY, ids, 1)).toBe(secondId);

    expect(rotateGoogleAntigravityAccountOn429(config, firstId, "45", "sess", now)).toBeTruthy();
    expect(getAccountRuntime(PROVIDER, firstId, now)?.state).toBe("RATE_LIMITED");
    const nextBeforeRestart = peekRoundRobinAccount(POOL_KEY_ANTIGRAVITY, ids, 1);
    expect(nextBeforeRestart).not.toBe(firstId);
    const cursorBeforeRestart = getPoolRotationSnapshot(POOL_KEY_ANTIGRAVITY);
    expect(cursorBeforeRestart).not.toBeNull();

    simulateRestart(now);

    expect(getAccountRuntime(PROVIDER, firstId, now)?.state).toBe("RATE_LIMITED");
    expect(getGoogleAntigravityAccountHealthSnapshot(firstId, now)?.cooldownUntil).toBe(now + 45_000);
    expect(peekRoundRobinAccount(POOL_KEY_ANTIGRAVITY, ids, 1)).not.toBe(firstId);
    expect(peekRoundRobinAccount(POOL_KEY_ANTIGRAVITY, ids, 1)).toBe(nextBeforeRestart);
    expect(getPoolRotationSnapshot(POOL_KEY_ANTIGRAVITY)?.weights).toEqual(cursorBeforeRestart?.weights);
    expect(resolveGoogleAntigravityAccountForSession("fresh-session", config, now).accountId)
      .not.toBe(firstId);
  });
});
