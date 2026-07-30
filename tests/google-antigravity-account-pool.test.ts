import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  POOL_KEY_ANTIGRAVITY,
  clearPoolRotationState,
  notePoolRotationFailure,
} from "../src/codex/pool-rotation";
import {
  bindGoogleAntigravitySessionAffinity,
  clearGoogleAntigravityAccountPoolState,
  getEligibleGoogleAntigravityAccounts,
  getGoogleAntigravityAccountHealthSnapshot,
  getGoogleAntigravityPoolCredential,
  googleAntigravitySessionKey,
  isGoogleAntigravityAccountPoolEnabled,
  releaseGoogleAntigravitySessionAffinity,
  resolveGoogleAntigravityAccountForSession,
  resetGoogleAntigravityRoutingForManualSelection,
  rotateGoogleAntigravityAccountOn429,
} from "../src/oauth/google-antigravity-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import {
  clearAccountQuotaCache,
  setCachedProviderAccountQuotaForTests,
} from "../src/providers/quota";
import type {
  OcxAccountPoolRotationStrategy,
  OcxConfig,
} from "../src/types";

const PROVIDER = "google-antigravity";
const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-antigravity-pool-"));
  process.env.OPENCODEX_HOME = home;
  clearGoogleAntigravityAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache(PROVIDER);
});

afterEach(() => {
  clearGoogleAntigravityAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache(PROVIDER);
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function config(
  enabled: boolean,
  threshold = 80,
  pool: {
    strategy?: OcxAccountPoolRotationStrategy;
    stickyLimit?: number;
  } = {},
): OcxConfig {
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
    googleAntigravityAccountPool: {
      enabled,
      autoSwitchThreshold: threshold,
      ...pool,
    },
  };
}

async function seedAccounts(count = 2): Promise<string[]> {
  for (let index = 0; index < count; index++) {
    const suffix = String.fromCharCode(97 + index);
    await saveCredential(PROVIDER, {
      access: `access-${suffix}`,
      refresh: `refresh-${suffix}`,
      expires: Date.now() + 3_600_000,
      accountId: `account-${suffix}`,
      email: `${suffix}@example.test`,
      projectId: `project-${suffix}`,
    });
  }
  const set = getAccountSet(PROVIDER)!;
  const ids = set.accounts.map(account => account.id);
  await setActiveAccount(PROVIDER, ids[0]!);
  return ids;
}

describe("Google Antigravity account pool", () => {
  test("is default-off and keeps the active account", async () => {
    const [activeId, otherId] = await seedAccounts();
    expect(isGoogleAntigravityAccountPoolEnabled(config(false))).toBe(false);
    const selection = resolveGoogleAntigravityAccountForSession(
      "session-1",
      config(false),
    );
    expect(selection).toEqual({ accountId: activeId, reason: "pool-disabled" });
    expect(selection.accountId).not.toBe(otherId);
  });

  test("uses antigravitySessionId as the stable affinity key", () => {
    const parsed = {
      context: { messages: [] },
    };
    const first = googleAntigravitySessionKey(parsed);
    const second = googleAntigravitySessionKey(parsed);
    expect(first).toBe(second);
    expect(first).toMatch(/^-\d+$/);
  });

  test("sticks a session to its selected account", async () => {
    const [activeId, otherId] = await seedAccounts();
    setCachedProviderAccountQuotaForTests(PROVIDER, activeId!, {
      fiveHourPercent: 95,
    });
    setCachedProviderAccountQuotaForTests(PROVIDER, otherId!, {
      fiveHourPercent: 10,
    });
    const first = resolveGoogleAntigravityAccountForSession(
      "sticky",
      config(true),
    );
    expect(first.accountId).toBe(otherId);
    setCachedProviderAccountQuotaForTests(PROVIDER, activeId!, {
      fiveHourPercent: 1,
    });
    expect(
      resolveGoogleAntigravityAccountForSession("sticky", config(true)),
    ).toEqual({ accountId: otherId, reason: "affinity" });
  });

  test("429 cools only the failed account and rebinds affinity", async () => {
    const [firstId, secondId] = await seedAccounts();
    bindGoogleAntigravitySessionAffinity("session-429", firstId!);
    const next = rotateGoogleAntigravityAccountOn429(
      config(true),
      firstId!,
      "30",
      "session-429",
    );
    expect(next).toBe(secondId);
    expect(getEligibleGoogleAntigravityAccounts()).toEqual([secondId]);
    expect(
      resolveGoogleAntigravityAccountForSession("session-429", config(true)),
    ).toEqual({ accountId: secondId, reason: "affinity" });
  });

  test("an unusable rotation target releases its session affinity", async () => {
    const [firstId, secondId] = await seedAccounts();
    const now = Date.now();
    bindGoogleAntigravitySessionAffinity("session-unusable", firstId!, now);
    expect(
      rotateGoogleAntigravityAccountOn429(
        config(true),
        firstId!,
        "30",
        "session-unusable",
        now,
      ),
    ).toBe(secondId);
    // Rotation binds the alternate before its credential is resolved.
    expect(
      resolveGoogleAntigravityAccountForSession(
        "session-unusable",
        config(true),
        now,
      ),
    ).toEqual({ accountId: secondId, reason: "affinity" });

    releaseGoogleAntigravitySessionAffinity("session-unusable", secondId!);

    // A mismatched release never drops another session's binding.
    bindGoogleAntigravitySessionAffinity("session-other", secondId!, now);
    releaseGoogleAntigravitySessionAffinity("session-other", firstId!);
    expect(
      resolveGoogleAntigravityAccountForSession(
        "session-other",
        config(true),
        now,
      ),
    ).toEqual({ accountId: secondId, reason: "affinity" });

    // The released session re-selects once the cooled account recovers instead of
    // staying pinned to the account that could not authenticate.
    expect(
      resolveGoogleAntigravityAccountForSession(
        "session-unusable",
        config(true),
        now + 31_000,
      ),
    ).toEqual({ accountId: firstId, reason: "active" });
  });

  test("non-429 outcomes do not change pool health or affinity", async () => {
    const [firstId] = await seedAccounts();
    bindGoogleAntigravitySessionAffinity("unchanged", firstId!);

    for (const status of [400, 502, 499]) {
      expect(status).not.toBe(429);
      expect(getGoogleAntigravityAccountHealthSnapshot(firstId!)).toBeNull();
      expect(
        resolveGoogleAntigravityAccountForSession("unchanged", config(true)),
      ).toEqual({ accountId: firstId, reason: "affinity" });
    }
  });

  test("all cooled accounts return all-cooled", async () => {
    const [firstId, secondId] = await seedAccounts();
    expect(
      rotateGoogleAntigravityAccountOn429(config(true), firstId!, "120"),
    ).toBe(secondId);
    expect(
      rotateGoogleAntigravityAccountOn429(config(true), secondId!, "120"),
    ).toBeNull();
    expect(
      resolveGoogleAntigravityAccountForSession("cooled", config(true)),
    ).toEqual({ accountId: null, reason: "all-cooled" });
  });

  test("round-robin rotates new sessions and affinity still wins", async () => {
    const ids = await seedAccounts(3);
    const poolConfig = config(true, 80, {
      strategy: "round-robin",
      stickyLimit: 1,
    });
    const picks = [
      resolveGoogleAntigravityAccountForSession("rr-1", poolConfig).accountId,
      resolveGoogleAntigravityAccountForSession("rr-2", poolConfig).accountId,
      resolveGoogleAntigravityAccountForSession("rr-3", poolConfig).accountId,
    ];
    expect(new Set(picks)).toEqual(new Set(ids));
    expect(
      resolveGoogleAntigravityAccountForSession("rr-1", poolConfig).accountId,
    ).toBe(picks[0]);
  });

  test("stickyLimit and manual active reset share the Antigravity ring", async () => {
    const ids = await seedAccounts(3);
    const poolConfig = config(true, 80, {
      strategy: "round-robin",
      stickyLimit: 3,
    });
    const first = resolveGoogleAntigravityAccountForSession(
      "batch-1",
      poolConfig,
    ).accountId;
    expect(
      resolveGoogleAntigravityAccountForSession("batch-2", poolConfig).accountId,
    ).toBe(first);
    expect(
      resolveGoogleAntigravityAccountForSession("batch-3", poolConfig).accountId,
    ).toBe(first);

    notePoolRotationFailure(POOL_KEY_ANTIGRAVITY, first!);
    expect(
      resolveGoogleAntigravityAccountForSession("batch-4", poolConfig).accountId,
    ).not.toBe(first);

    resetGoogleAntigravityRoutingForManualSelection(ids[2]!);
    expect(
      resolveGoogleAntigravityAccountForSession("manual", poolConfig).accountId,
    ).toBe(ids[2]);
  });

  test("returns token and project from the same account", async () => {
    const [firstId, secondId] = await seedAccounts();
    await expect(getGoogleAntigravityPoolCredential(firstId!)).resolves.toEqual({
      accessToken: "access-a",
      projectId: "project-a",
    });
    await expect(getGoogleAntigravityPoolCredential(secondId!)).resolves.toEqual({
      accessToken: "access-b",
      projectId: "project-b",
    });
  });
});
