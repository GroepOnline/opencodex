import { describe, expect, spyOn, test } from "bun:test";
import {
  elapsedUsageDurationMs,
  sanitizeUsageDurationMs,
  USAGE_DURATION_HARD_MAX_MS,
} from "../src/usage/duration";
import { addFinalRequestLog, finishRequestAttempt, beginRequestAttempt } from "../src/server/request-log";
import type { RequestLogEntry } from "../src/server/request-log";

describe("usage duration sanitizer", () => {
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
      addFinalRequestLog("ocx-duration", 0, { model: "m", provider: "p" }, 200, undefined, entry => captured.push(entry));
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
