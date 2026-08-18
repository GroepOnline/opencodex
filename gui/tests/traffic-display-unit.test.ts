import { expect, test } from "bun:test";
import {
  formatTrafficLabel,
  isUnknownTrafficLabel,
  localTrafficDateKey,
  resolveRequestsToday,
  trafficPrincipalLabel,
} from "../src/traffic-display";

test("localTrafficDateKey uses the browser-local calendar day", () => {
  const ts = Date.UTC(2026, 7, 18, 22, 30, 0);
  const key = localTrafficDateKey(ts);
  expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("resolveRequestsToday counts live log rows including failures", () => {
  const key = localTrafficDateKey();
  const rows = [
    { timestamp: Date.now() },
    { timestamp: Date.now() - 86_400_000 },
  ];
  expect(resolveRequestsToday([{ date: key, requests: 0 }], rows)).toBe(1);
});

test("unknown traffic labels localize through i18n", () => {
  const t = (key: string) => (key === "common.unknown" ? "Onbekend" : key);
  expect(isUnknownTrafficLabel("unknown")).toBe(true);
  expect(formatTrafficLabel("unknown", t)).toBe("Onbekend");
  expect(trafficPrincipalLabel({ provider: "unknown" }, t)).toBe("Onbekend");
  expect(trafficPrincipalLabel({ provider: "kilo" }, t)).toBe("kilo");
  expect(trafficPrincipalLabel({ provider: "unknown", principal: "kilo" }, t)).toBe("kilo");
});
