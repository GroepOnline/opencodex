import { describe, expect, test } from "bun:test";
import {
  countRequestsOnDay,
  localCalendarDayKey,
  requestsTodayCount,
  trafficPrincipalLabel,
  trafficProviderModelLabel,
} from "../gui/src/traffic-shared";

const t = (key: string) => (key === "vk.unknown" ? "Onbekend" : key);

describe("traffic-shared", () => {
  test("localCalendarDayKey uses the local calendar date", () => {
    const local = new Date(2026, 7, 18, 1, 30, 0);
    expect(localCalendarDayKey(local)).toBe("2026-08-18");
  });

  test("requestsTodayCount uses the complete summary when it exceeds the live tail", () => {
    const key = localCalendarDayKey();
    const logs = [
      { timestamp: Date.now(), model: "m", provider: "kilo", status: 400, durationMs: 1 },
      { timestamp: Date.now() - 86_400_000, model: "m", provider: "kilo", status: 200, durationMs: 1 },
    ];
    expect(countRequestsOnDay(logs, key)).toBe(1);
    expect(requestsTodayCount(logs, [{ date: key, requests: 3 }])).toBe(3);
  });

  test("trafficProviderModelLabel falls back to requestedModel", () => {
    expect(trafficProviderModelLabel({
      timestamp: 0,
      model: "unknown",
      provider: "unknown",
      requestedModel: "tencent/hy3:free",
      status: 400,
      durationMs: 1,
    })).toBe("tencent/hy3:free");
    expect(trafficProviderModelLabel({
      timestamp: 0,
      model: "claude-3",
      provider: "anthropic",
      status: 200,
      durationMs: 1,
    })).toBe("anthropic/claude-3");
  });

  test("trafficPrincipalLabel uses account suffix or provider key", () => {
    expect(trafficPrincipalLabel({
      timestamp: 0,
      model: "m",
      provider: "openai-p104398",
      account: "p104398",
      status: 200,
      durationMs: 1,
    }, t)).toBe("p104398");
    expect(trafficPrincipalLabel({
      timestamp: 0,
      model: "m",
      provider: "kilo",
      status: 200,
      durationMs: 1,
    }, t)).toBe("kilo");
    expect(trafficPrincipalLabel({
      timestamp: 0,
      model: "unknown",
      provider: "unknown",
      status: 400,
      durationMs: 1,
    }, t)).toBe("Onbekend");
  });
});
