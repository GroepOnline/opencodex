import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageEntry,
  readUsageEntries,
  resetUsageReadCacheForTests,
  usageLogPath,
} from "../src/usage/log";
import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  elapsedUsageDurationMs,
  sanitizeUsageDurationMs,
  USAGE_DURATION_HARD_MAX_MS,
} from "../src/usage/duration";
import {
  addFinalRequestLog,
  finishRequestAttempt,
  beginRequestAttempt,
} from "../src/server/request-log";
import type { RequestLogEntry } from "../src/server/request-log";

describe("usage duration sanitizer", () => {
  test.each([0, 0.25, 2_500])(
    "accepts %s ms through the uptime slack boundary",
    (durationMs) => {
      const warn = mock(() => {});
      expect(
        sanitizeUsageDurationMs(durationMs, { uptimeMs: 1_500, warn }),
      ).toBe(durationMs);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  test.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("rejects invalid duration %s with a scalar warning", (durationMs) => {
    const warn = mock(() => {});
    expect(sanitizeUsageDurationMs(durationMs, { uptimeMs: 1_500, warn })).toBe(
      0,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({
      event: "usage_duration_rejected",
      reason: "invalid",
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      capMs: 2_500,
      uptimeMs: 1_500,
    });
  });

  test.each([
    { uptimeMs: 1_500, maxMs: undefined, capMs: 2_500 },
    { uptimeMs: 10_000, maxMs: 500, capMs: 500 },
    { uptimeMs: 10_000, maxMs: 0, capMs: 0 },
    { uptimeMs: -500, maxMs: undefined, capMs: 1_000 },
    {
      uptimeMs: USAGE_DURATION_HARD_MAX_MS * 2,
      maxMs: undefined,
      capMs: USAGE_DURATION_HARD_MAX_MS,
    },
  ])(
    "accepts the cap and rejects one millisecond above it: %j",
    ({ uptimeMs, maxMs, capMs }) => {
      const warn = mock(() => {});
      expect(sanitizeUsageDurationMs(capMs, { uptimeMs, maxMs, warn })).toBe(
        capMs,
      );
      expect(warn).not.toHaveBeenCalled();
      expect(
        sanitizeUsageDurationMs(capMs + 1, { uptimeMs, maxMs, warn }),
      ).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith({
        event: "usage_duration_rejected",
        reason: "exceeds_cap",
        durationMs: capMs + 1,
        capMs,
        uptimeMs,
      });
    },
  );

  test.each([
    [Number.NaN, 1_000],
    [1_000, Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY, 1_000],
  ])("rejects invalid clock endpoints (%s, %s)", (start, now) => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(elapsedUsageDurationMs(start, now)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
        event: "usage_duration_rejected",
        reason: "invalid_clock",
        durationMs: null,
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("rejects a clock moving backwards but accepts identical endpoints", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(elapsedUsageDurationMs(1_000, 1_000)).toBe(0);
      expect(warn).not.toHaveBeenCalled();
      expect(elapsedUsageDurationMs(1_001, 1_000)).toBe(0);
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
        reason: "invalid",
        durationMs: -1,
      });
    } finally {
      warn.mockRestore();
    }
  });

  test.each([undefined, 0, 250])(
    "finalizes request and attempt using their own start times (%s)",
    (attemptOffset) => {
      const now = 1_700_000_000_000;
      const clock = spyOn(Date, "now").mockReturnValue(now);
      const uptime = spyOn(process, "uptime").mockReturnValue(10);
      try {
        const attempt = beginRequestAttempt(
          1,
          "fixture",
          "model",
          "openai-chat",
        );
        const captured: RequestLogEntry[] = [];
        addFinalRequestLog(
          "duration-starts",
          now - 500,
          {
            provider: "fixture",
            model: "model",
            activeAttempt: attempt,
            activeAttemptStartedAt:
              attemptOffset === undefined ? undefined : now - attemptOffset,
            attempts: [attempt],
          },
          200,
          undefined,
          (entry) => captured.push(entry),
        );
        expect(captured).toHaveLength(1);
        expect(captured[0]!.durationMs).toBe(500);
        expect(captured[0]!.attempts).toHaveLength(1);
        expect(captured[0]!.attempts![0]!.durationMs).toBe(
          attemptOffset ?? 500,
        );
        expect(attempt.status).toBe(200);
      } finally {
        uptime.mockRestore();
        clock.mockRestore();
      }
    },
  );

  test("persistence accepts historical durations and sanitizes attempts without mutating callers", () => {
    const previous = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-duration-boundary-"));
    process.env.OPENCODEX_HOME = home;
    const uptime = spyOn(process, "uptime").mockReturnValue(0);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const durations = [
        0,
        0.25,
        USAGE_DURATION_HARD_MAX_MS,
        USAGE_DURATION_HARD_MAX_MS + 1,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ];
      const attempts = durations.map((durationMs, index) => ({
        ...beginRequestAttempt(index + 1, "fixture", "model", "openai-chat"),
        status: 200,
        durationMs,
      }));
      const snapshot = structuredClone(attempts);
      appendUsageEntry({
        requestId: "duration-boundaries",
        timestamp: 1,
        provider: "fixture",
        model: "model",
        status: 200,
        durationMs: USAGE_DURATION_HARD_MAX_MS,
        usageStatus: "unreported",
        attempts: [
          ...attempts,
          { ...attempts[0]!, durationMs: "42" } as never,
          { ...attempts[0]!, ordinal: 0 },
        ],
      });
      // Inspect bytes on disk so read-time normalization cannot hide a bad append.
      const persisted = JSON.parse(readFileSync(usageLogPath(), "utf8"));
      expect(persisted.durationMs).toBe(USAGE_DURATION_HARD_MAX_MS);
      expect(
        persisted.attempts.map(
          (attempt: { durationMs: number }) => attempt.durationMs,
        ),
      ).toEqual([0, 0.25, USAGE_DURATION_HARD_MAX_MS, 0, 0, 0, 0]);
      expect(attempts).toEqual(snapshot);
    } finally {
      warn.mockRestore();
      uptime.mockRestore();
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      resetUsageReadCacheForTests();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects absolute timestamps at the persistence boundary", () => {
    const previous = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-duration-persist-"));
    process.env.OPENCODEX_HOME = home;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      appendUsageEntry({
        requestId: "duration-regression",
        timestamp: 1,
        provider: "fixture",
        model: "fixture",
        status: 200,
        durationMs: Date.now(),
        usageStatus: "unreported",
        attempts: [
          null as never,
          {
            ordinal: 1,
            provider: "fixture",
            model: "fixture",
            adapter: "fixture",
            status: 200,
            durationMs: Date.now(),
            sendCount: 1,
            recoveryKinds: [],
            usageStatus: "unreported",
          },
          {
            ordinal: 2,
            provider: "fixture",
            model: "fixture",
            adapter: "fixture",
            status: 200,
            durationMs: 42,
            sendCount: 1,
            recoveryKinds: [],
            usageStatus: "unreported",
          },
        ],
      });
      const persisted = readUsageEntries()[0];
      expect(persisted?.durationMs).toBe(0);
      expect(persisted?.attempts?.[0]?.durationMs).toBe(0);
      expect(persisted?.attempts?.[1]?.durationMs).toBe(42);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      resetUsageReadCacheForTests();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("keeps a plausible elapsed duration", () => {
    expect(sanitizeUsageDurationMs(42, { uptimeMs: 5_000 })).toBe(42);
    expect(elapsedUsageDurationMs(1_000, 1_250)).toBe(250);
  });

  test("rejects a duration larger than process uptime", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const uptimeMs = 1_500;
      const rejected = sanitizeUsageDurationMs(uptimeMs + 60_000, { uptimeMs });
      expect(rejected).toBe(0);
      expect(warn).toHaveBeenCalled();
      const payload = JSON.parse(String(warn.mock.calls[0]?.[0])) as {
        event: string;
        reason: string;
        durationMs: number;
        capMs: number;
      };
      expect(payload).toMatchObject({
        event: "usage_duration_rejected",
        reason: "exceeds_cap",
        durationMs: uptimeMs + 60_000,
      });
      expect(payload.capMs).toBeLessThanOrEqual(uptimeMs + 1_000);
      expect(JSON.stringify(payload)).not.toContain("sk-");
      expect(JSON.stringify(payload)).not.toContain("Bearer");
    } finally {
      warn.mockRestore();
    }
  });

  test("rejects Date.now() assigned as durationMs", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const wallClock = Date.now();
      expect(sanitizeUsageDurationMs(wallClock, { uptimeMs: 10_000 })).toBe(0);
      expect(elapsedUsageDurationMs(0, wallClock)).toBe(0);
      expect(wallClock).toBeGreaterThan(USAGE_DURATION_HARD_MAX_MS);
    } finally {
      warn.mockRestore();
    }
  });

  test("addFinalRequestLog never writes a wall-clock timestamp into durationMs", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const captured: RequestLogEntry[] = [];
      addFinalRequestLog(
        "ocx-duration",
        0,
        { model: "m", provider: "p" },
        200,
        undefined,
        (entry) => captured.push(entry),
      );
      expect(captured).toHaveLength(1);
      expect(captured[0]!.durationMs).toBe(0);
      expect(captured[0]!.durationMs).toBeLessThan(1e12);
    } finally {
      warn.mockRestore();
    }
  });

  test("finishRequestAttempt rejects a Date.now() duration", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const attempt = beginRequestAttempt(1, "openai", "gpt", "openai-chat");
      finishRequestAttempt(attempt, 200, Date.now());
      expect(attempt.durationMs).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
