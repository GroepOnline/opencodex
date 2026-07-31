import { describe, expect, test } from "bun:test";
import {
  isHardCapMessage,
  parseResetsInMs,
} from "../src/providers/cap-cooldown";

describe("parseResetsInMs", () => {
  test("parses Clinepass-style 'resets in 1d 22h'", () => {
    const now = Date.UTC(2026, 6, 31, 0, 0, 0);
    const until = parseResetsInMs("Error 429: You have reached your weekly Clinepass limit. The limit resets in 1d 22h, please try again later.", now);
    expect(until).toBe(now + (1 * 24 + 22) * 60 * 60 * 1000);
  });

  test("parses hours-only", () => {
    const now = 1_000_000;
    expect(parseResetsInMs("resets in 3h", now)).toBe(now + 3 * 60 * 60 * 1000);
  });

  test("returns undefined when no match", () => {
    expect(parseResetsInMs("rate limited, try later")).toBeUndefined();
  });
});

describe("isHardCapMessage", () => {
  test("detects INFERENCE_CAP_ERROR", () => {
    expect(isHardCapMessage(429, '{"code":"INFERENCE_CAP_ERROR","message":"weekly Clinepass limit"}')).toBe(true);
  });

  test("ignores ordinary rate limits", () => {
    expect(isHardCapMessage(429, "Too many requests")).toBe(false);
  });

  test("ignores non-429", () => {
    expect(isHardCapMessage(500, "INFERENCE_CAP_ERROR")).toBe(false);
  });
});
