import { describe, expect, test } from "bun:test";
import { formatUptime } from "../src/formatUptime";

describe("locale-aware uptime formatting", () => {
  test("renders Dutch hour units instead of the English abbreviation", () => {
    expect(formatUptime(3600, "nl")).toBe("1u");
    expect(formatUptime(3660, "nl")).toBe("1u 1m");
    expect(formatUptime(90_000, "nl")).toBe("1d 1u");
  });

  test("renders English units", () => {
    expect(formatUptime(3600, "en")).toBe("1h");
    expect(formatUptime(3660, "en")).toBe("1h 1m");
    expect(formatUptime(90_000, "en")).toBe("1d 1h");
  });

  test("collapses whole days and sub-5-minute uptimes", () => {
    expect(formatUptime(86_400, "en")).toBe("1d");
    expect(formatUptime(86_400, "nl")).toBe("1d");
    expect(formatUptime(42, "en")).toBe("42s");
    expect(formatUptime(600, "en")).toBe("10m");
  });

  test("clamps negative and fractional input", () => {
    expect(formatUptime(-10, "en")).toBe("0s");
    expect(formatUptime(59.9, "en")).toBe("59s");
  });
});
