import { describe, expect, test } from "bun:test";
import {
  trafficStatusClass,
  trafficStatusLabel,
  type TrafficLogEntry,
} from "../src/traffic-shared";

const t = (
  key:
    | "vk.stampDone"
    | "vk.stampError"
    | "vk.stampBusy"
    | "vk.stampRateLimited"
    | "vk.stampPayment",
) => key;

function entry(status: number): TrafficLogEntry {
  return {
    timestamp: 0,
    model: "gpt-test",
    provider: "openai",
    status,
    durationMs: 12,
  };
}

describe("traffic status stamps", () => {
  test("labels 429 as rate-limited and 402 as payment", () => {
    expect(trafficStatusLabel(entry(200), t)).toBe("vk.stampDone");
    expect(trafficStatusLabel(entry(429), t)).toBe("vk.stampRateLimited");
    expect(trafficStatusLabel(entry(402), t)).toBe("vk.stampPayment");
    expect(trafficStatusLabel(entry(500), t)).toBe("vk.stampError");
    expect(trafficStatusLabel(entry(0), t)).toBe("vk.stampError");
    expect(trafficStatusLabel(entry(101), t)).toBe("vk.stampBusy");
  });

  test("classes keep 429 on hold and 402 on error", () => {
    expect(trafficStatusClass(entry(200))).toBe("traffic-status--ok");
    expect(trafficStatusClass(entry(429))).toBe("traffic-status--hold");
    expect(trafficStatusClass(entry(402))).toBe("traffic-status--err");
    expect(trafficStatusClass(entry(503))).toBe("traffic-status--err");
  });
});
