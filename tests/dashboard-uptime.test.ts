import { describe, expect, test } from "bun:test";
import { formatUptime } from "../gui/src/formatUptime";

describe("dashboard uptime formatting", () => {
  test("keeps short uptimes in seconds", () => {
    expect(formatUptime(0, "nl")).toBe("0s");
    expect(formatUptime(299.9, "nl")).toBe("299s");
  });

  test("uses minutes after five minutes", () => {
    expect(formatUptime(300, "nl")).toBe("5m");
    expect(formatUptime(3599, "nl")).toBe("59m");
  });

  test("uses hours and minutes after one hour", () => {
    expect(formatUptime(3600, "nl")).toBe("1u");
    expect(formatUptime(64685, "nl")).toBe("17u 58m");
  });

  test("uses days and hours after one day", () => {
    expect(formatUptime(86400, "nl")).toBe("1d");
    expect(formatUptime(183600, "nl")).toBe("2d 3u");
  });

  test("uses compact localized units", () => {
    expect(formatUptime(3720, "en")).toBe("1h 2m");
    expect(formatUptime(93600, "nl")).toBe("1d 2u");
  });
});
