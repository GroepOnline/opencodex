import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { codexPaceBeforeSend, resetCodexPacerState } from "../src/codex/pacer";
import type { OcxConfig } from "../src/types";

// Minimal helper: wrap global setTimeout so we can observe the delay it would
// schedule without skipping the real wait (tests use small bounds). Captures
// every positive delay passed to setTimeout during the patched window.
function withSetTimeoutSpy<T>(fn: () => Promise<T>): { scheduled: number[]; result: Promise<T> } {
  const scheduled: number[] = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: TimerHandler, ms?: number, ...rest: unknown[]) => {
    if (typeof ms === "number" && ms > 0) scheduled.push(ms);
    return real(callback, ms, ...(rest as []));
  }) as typeof globalThis.setTimeout;
  const result = fn().finally(() => {
    globalThis.setTimeout = real;
  });
  return { scheduled, result };
}

function makeConfig(pacing: OcxConfig["codexRequestPacing"]): OcxConfig {
  return { codexRequestPacing: pacing } as OcxConfig;
}

describe("codex request pacer", () => {
  let realDateNow: typeof Date.now;
  let realMathRandom: typeof Math.random;

  beforeEach(() => {
    resetCodexPacerState();
    realDateNow = Date.now;
    realMathRandom = Math.random;
  });

  afterEach(() => {
    Date.now = realDateNow;
    Math.random = realMathRandom;
    resetCodexPacerState();
  });

  test("disabled resolves instantly and schedules no delay", async () => {
    const { scheduled, result } = withSetTimeoutSpy(() =>
      codexPaceBeforeSend(makeConfig({ enabled: false, minMs: 1000, maxMs: 2000 }), "x"),
    );
    await result;
    expect(scheduled).toEqual([]);
  });

  test("enabled emits a delay within [minMs, maxMs] between consecutive same-account sends", async () => {
    // Fix the jitter (mid-range) and freeze the clock so the gap is deterministic.
    Date.now = (() => 10_000) as typeof Date.now;
    Math.random = (() => 0.5) as typeof Math.random;

    const config = makeConfig({ enabled: true, minMs: 100, maxMs: 200 });
    const { scheduled, result } = withSetTimeoutSpy(async () => {
      // First send: no prior timestamp -> no delay, records lastSendAt = 10_000.
      await codexPaceBeforeSend(config, "x");
      // Advance the clock slightly; second send waits gap(150) - elapsed(5) = 145.
      Date.now = (() => 10_005) as typeof Date.now;
      await codexPaceBeforeSend(config, "x");
    });
    await result;

    expect(scheduled).toHaveLength(1);
    const delay = scheduled[0]!;
    expect(delay).toBeGreaterThanOrEqual(100);
    expect(delay).toBeLessThanOrEqual(200);
    expect(delay).toBeCloseTo(145, -1); // 150 - 5
  });

  test("per-account state desyncs: a fresh account never waits on another's history", async () => {
    Date.now = (() => 10_000) as typeof Date.now;
    Math.random = (() => 0.5) as typeof Math.random;

    const config = makeConfig({ enabled: true, minMs: 100, maxMs: 200 });
    const { scheduled, result } = withSetTimeoutSpy(async () => {
      // Prime account x twice so it has a recent send and would wait on a repeat.
      await codexPaceBeforeSend(config, "x");
      Date.now = (() => 10_010) as typeof Date.now;
      await codexPaceBeforeSend(config, "x"); // x now has history -> waits ~140ms
      // Account y has never sent: its first call must not inherit x's cadence.
      Date.now = (() => 10_010) as typeof Date.now;
      await codexPaceBeforeSend(config, "y");
    });
    await result;

    // Exactly one delay scheduled (x's repeat). y's first send adds none.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toBeGreaterThanOrEqual(100);
  });

  test("enabled with no accountId is a no-op (defensive)", async () => {
    Date.now = (() => 10_000) as typeof Date.now;
    Math.random = (() => 0.5) as typeof Math.random;
    const { scheduled, result } = withSetTimeoutSpy(() =>
      codexPaceBeforeSend(makeConfig({ enabled: true, minMs: 100, maxMs: 200 }), null),
    );
    await result;
    expect(scheduled).toEqual([]);
  });

  test("elapsed longer than the gap floors the wait at zero", async () => {
    Date.now = (() => 10_000) as typeof Date.now;
    Math.random = (() => 0) as typeof Math.random; // gap = minMs = 100
    const config = makeConfig({ enabled: true, minMs: 100, maxMs: 200 });
    const { scheduled, result } = withSetTimeoutSpy(async () => {
      await codexPaceBeforeSend(config, "x"); // records 10_000
      // Far more than the gap has elapsed -> no wait.
      Date.now = (() => 100_000) as typeof Date.now;
      await codexPaceBeforeSend(config, "x");
    });
    await result;
    expect(scheduled).toEqual([]);
  });
});
