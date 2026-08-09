import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  recordCodexUpstreamOutcome,
  resetCodexRoundRobinCursor,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota, updateAccountQuota } from "../src/codex/auth-api";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-rotation-test");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: [
      { id: "a", email: "a@test", isMain: false },
      { id: "b", email: "b@test", isMain: false },
      { id: "c", email: "c@test", isMain: false },
    ],
    activeCodexAccountId: "a",
    autoSwitchThreshold: 80,
    upstreamFailoverThreshold: 3,
    codexRotationMode: "round-robin",
    ...overrides,
  } as OcxConfig;
}

function saveTestCredential(id: string): void {
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${id}`,
  });
}

describe("codex round-robin rotation", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    // No auth.json in TEST_DIR -> main account deterministically absent, so the
    // eligible pool is exactly the configured non-main accounts in config order.
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = TEST_DIR;
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    resetCodexRoundRobinCursor();
    for (const id of ["a", "b", "c"]) {
      clearAccountNeedsReauth(id);
      saveTestCredential(id);
    }
  });

  afterEach(() => {
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    resetCodexRoundRobinCursor();
    for (const id of ["a", "b", "c"]) clearAccountNeedsReauth(id);
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("cycles across all usable pool accounts as the cursor advances", () => {
    const config = makeConfig();
    // Cursor walks a -> b -> c, then wraps back to a.
    expect(resolveCodexAccountForThread("rr-1", config)).toBe("a");
    expect(resolveCodexAccountForThread("rr-2", config)).toBe("b");
    expect(resolveCodexAccountForThread("rr-3", config)).toBe("c");
    expect(resolveCodexAccountForThread("rr-4", config)).toBe("a");
    expect(resolveCodexAccountForThread("rr-5", config)).toBe("b");
    // activeCodexAccountId is left untouched by round-robin.
    expect(config.activeCodexAccountId).toBe("a");
  });

  test("a cooldown'd account is skipped by the rotation", () => {
    const config = makeConfig();
    // Put b into hard cooldown via a 429 quota outcome.
    recordCodexUpstreamOutcome(config, "b", 429, { retryAfter: "120" });
    // Pool is now [a, c]; rotation walks a -> c -> a -> c, never b.
    expect(resolveCodexAccountForThread("skip-1", config)).toBe("a");
    expect(resolveCodexAccountForThread("skip-2", config)).toBe("c");
    expect(resolveCodexAccountForThread("skip-3", config)).toBe("a");
    expect(resolveCodexAccountForThread("skip-4", config)).toBe("c");
  });

  test("a single usable account collapses to a no-op (always that account)", () => {
    const config = makeConfig({
      codexAccounts: [{ id: "a", email: "a@test", isMain: false }],
      activeCodexAccountId: "a",
    });
    expect(resolveCodexAccountForThread("solo-1", config)).toBe("a");
    expect(resolveCodexAccountForThread("solo-2", config)).toBe("a");
    expect(resolveCodexAccountForThread("solo-3", config)).toBe("a");
    expect(config.activeCodexAccountId).toBe("a");
  });

  test("default failover mode is unaffected when rotation mode is not set", () => {
    // No codexRotationMode -> sticky failover path, cursor never advances.
    const config = makeConfig({ codexRotationMode: undefined });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    expect(resolveCodexAccountForThread("failover-1", config)).toBe("a");
    expect(resolveCodexAccountForThread("failover-2", config)).toBe("a");
  });

  test("round-robin does not mutate persisted active account selection state", () => {
    const config = makeConfig();
    resolveCodexAccountForThread("no-mutate-1", config);
    resolveCodexAccountForThread("no-mutate-2", config);
    // Neither config.activeCodexAccountId nor the in-memory affinity map is
    // repointed by round-robin (it returns early before setActiveCodexAccount).
    expect(config.activeCodexAccountId).toBe("a");
  });
});
