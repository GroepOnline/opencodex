import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState } from "../src/codex/pool-rotation";
import {
  bindCursorSessionAffinity,
  clearCursorAccountPoolState,
  cursorSessionKeyFromParts,
  getCursorAccountHealthSnapshot,
  isCursorAccountPoolEnabled,
  isCursorPoolRotationError,
  resolveCursorAccountForSession,
  rotateCursorAccountOnQuota,
} from "../src/oauth/cursor-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";
import type { OcxConfig } from "../src/types";

const PROVIDER = "cursor";
const originalHome = process.env.OPENCODEX_HOME;
let home = "";

function config(enabled: boolean): OcxConfig {
  return {
    port: 0,
    defaultProvider: PROVIDER,
    providers: {
      [PROVIDER]: {
        adapter: "cursor",
        baseUrl: "https://api2.cursor.sh",
        authMode: "oauth",
      },
    },
    cursorAccountPool: { enabled },
  };
}

async function seedAccounts(): Promise<string[]> {
  for (const suffix of ["a", "b"]) {
    await saveCredential(PROVIDER, {
      access: `cursor-token-${suffix}`,
      refresh: `cursor-refresh-${suffix}`,
      expires: Date.now() + 3_600_000,
      accountId: `cursor-account-${suffix}`,
      email: `${suffix}@example.test`,
    });
  }
  const ids = getAccountSet(PROVIDER)!.accounts.map(account => account.id);
  await setActiveAccount(PROVIDER, ids[0]!);
  return ids;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-cursor-pool-"));
  process.env.OPENCODEX_HOME = home;
  clearCursorAccountPoolState();
  clearPoolRotationState();
});

afterEach(() => {
  clearCursorAccountPoolState();
  clearPoolRotationState();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("Cursor account pool", () => {
  test("is default-off and keeps the active account", async () => {
    const [activeId] = await seedAccounts();
    expect(isCursorAccountPoolEnabled(config(false))).toBe(false);
    expect(resolveCursorAccountForSession("session", config(false))).toEqual({
      accountId: activeId,
      reason: "pool-disabled",
    });
  });

  test("keeps sticky session affinity", async () => {
    const [firstId, secondId] = await seedAccounts();
    bindCursorSessionAffinity("sticky", secondId!);
    expect(resolveCursorAccountForSession("sticky", config(true))).toEqual({
      accountId: secondId,
      reason: "affinity",
    });
    expect(resolveCursorAccountForSession("other", config(true)).accountId).toBe(firstId);
  });

  test("quota rotation cools the failed account and rebinds affinity", async () => {
    const [firstId, secondId] = await seedAccounts();
    bindCursorSessionAffinity("quota-session", firstId!);
    expect(
      rotateCursorAccountOnQuota(config(true), firstId!, "30", "quota-session"),
    ).toBe(secondId);
    expect(getCursorAccountHealthSnapshot(firstId!)).not.toBeNull();
    expect(resolveCursorAccountForSession("quota-session", config(true))).toEqual({
      accountId: secondId,
      reason: "affinity",
    });
  });

  test("an upstream Retry-After sets the cooldown instead of the default", async () => {
    const [firstId] = await seedAccounts();
    const before = Date.now();
    rotateCursorAccountOnQuota(config(true), firstId!, "120", "retry-after-session");
    const snapshot = getCursorAccountHealthSnapshot(firstId!);
    expect(snapshot?.cooldownSource).toBe("retry-after");
    // 120s from the server, not the 60s default: assert the window lands past the default so a
    // regression that drops the header cannot pass.
    expect(snapshot!.cooldownUntil!).toBeGreaterThan(before + 90_000);
    expect(snapshot!.cooldownUntil!).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  test("a missing Retry-After falls back to the default cooldown", async () => {
    const [firstId] = await seedAccounts();
    const before = Date.now();
    rotateCursorAccountOnQuota(config(true), firstId!, null, "default-session");
    const snapshot = getCursorAccountHealthSnapshot(firstId!);
    expect(snapshot?.cooldownSource).toBe("default");
    // Bound with a timestamp taken after the rotation: the clock can tick between
    // `before` and the rotation's own Date.now(), so `before + 60_000` is racy.
    expect(snapshot!.cooldownUntil!).toBeGreaterThanOrEqual(before + 60_000);
    expect(snapshot!.cooldownUntil!).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  test("only explicit rate, quota, and overload failures qualify for rotation", () => {
    for (const message of [
      "Cursor rate limit exceeded: HTTP 429 Too Many Requests",
      "Cursor rate limit exceeded: RESOURCE_EXHAUSTED",
      "Cursor quota exhausted: usage limit has been reached",
      "overloaded_error: Overloaded",
    ]) {
      expect(isCursorPoolRotationError(message)).toBe(true);
    }
    for (const message of [
      "adapter_eof",
      "client cancelled request",
      "Cursor server overloaded: Provider error 502",
      "Cursor upstream error",
      "Cursor resource limit exceeded: tool catalog too large",
    ]) {
      expect(isCursorPoolRotationError(message)).toBe(false);
    }
  });

  test("builds one stable, opaque affinity key per session source", () => {
    const first = cursorSessionKeyFromParts({ clientThreadId: "thread-1" });
    const second = cursorSessionKeyFromParts({
      clientThreadId: "thread-1",
      sessionIdHeader: "ignored-lower-priority",
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(cursorSessionKeyFromParts({})).toBeNull();
  });
});
