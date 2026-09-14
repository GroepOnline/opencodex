import { describe, expect, test } from "bun:test";
import {
  formatCreditDate,
  formatCreditDateTime,
  formatPercent,
  formatUsd,
} from "../src/intl-formatters";

describe("credit date formatting", () => {
  test("keeps the compact date format for grant dates", () => {
    const iso = "2026-07-31T12:34:56Z";
    const time = new Intl.DateTimeFormat("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));

    expect(formatCreditDate(iso, "de-DE")).not.toContain(time);
  });

  test("includes the local time for expiration dates", () => {
    const iso = "2026-07-31T12:34:56Z";

    const time = new Intl.DateTimeFormat("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));

    expect(formatCreditDateTime(iso, "de-DE")).toContain(time);
    expect(formatCreditDateTime(iso, "de-DE")).not.toBe("—");
  });

  test("handles invalid dates consistently", () => {
    expect(formatCreditDateTime("invalid")).toBe("—");
  });
});

describe("locale-aware number display", () => {
  test("formats USD with two fraction digits", () => {
    expect(formatUsd(1.2, "en-US")).toBe("$1.20");
    expect(formatUsd(1.2, "nl-NL")).toMatch(/1,20/);
  });

  test("formats ratios as whole-number percents", () => {
    expect(formatPercent(0.123, "en-US")).toBe("12%");
  });
});
