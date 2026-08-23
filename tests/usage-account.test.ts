import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFinalRequestLog,
  applyRoutedAccount,
  type RequestLogContext,
  type RequestLogEntry,
} from "../src/server/request-log";
import { addRequestLog } from "../src/server/request-log";
import { readUsageEntries, resetUsageReadCacheForTests } from "../src/usage/log";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-account-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  resetUsageReadCacheForTests();
});

describe("usage account attribution", () => {
  test("persists the routed account id, not a scraped label hash", () => {
    const captured: RequestLogEntry[] = [];
    const logCtx: RequestLogContext = { model: "gpt-5.6-sol", provider: "openai-p104398" };
    applyRoutedAccount(logCtx, "acct-real-42");
    addFinalRequestLog("ocx-account", Date.now(), logCtx, 200, undefined, entry => captured.push(entry));
    expect(captured[0]).toMatchObject({
      provider: "openai-p104398",
      account: "acct-real-42",
    });
    expect(captured[0]!.account).not.toBe("p104398");
  });

  test("writes account null when routing selected none", () => {
    const captured: RequestLogEntry[] = [];
    addFinalRequestLog(
      "ocx-no-account",
      Date.now(),
      { model: "gpt-test", provider: "kilo" },
      200,
      undefined,
      entry => captured.push(entry),
    );
    expect(captured[0]!.account).toBeNull();
  });

  test("JSONL always contains an explicit account field", () => {
    addRequestLog({
      requestId: "ocx-account-jsonl",
      timestamp: 1,
      model: "gpt-test",
      provider: "openai",
      status: 200,
      durationMs: 10,
      usageStatus: "unreported",
    });
    const raw = readFileSync(join(testDir, "usage.jsonl"), "utf-8");
    expect(raw).toContain("\"account\":null");
    expect(readUsageEntries()[0]?.account).toBeNull();

    addRequestLog({
      requestId: "ocx-account-jsonl-id",
      timestamp: 2,
      model: "gpt-test",
      provider: "openai-p104398",
      account: "acct-from-routing",
      status: 200,
      durationMs: 11,
      usageStatus: "unreported",
    });
    const rows = readUsageEntries();
    expect(rows[1]?.account).toBe("acct-from-routing");
    expect(rows[1]?.account).not.toBe("p104398");
  });
});
