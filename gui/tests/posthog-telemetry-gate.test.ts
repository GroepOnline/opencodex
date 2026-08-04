import { describe, expect, test } from "bun:test";
import { isPostHogTelemetryAllowed } from "../src/posthog";

function storage(map: Record<string, string>): Pick<Storage, "getItem"> {
  return { getItem: (k) => (k in map ? map[k]! : null) };
}

describe("isPostHogTelemetryAllowed", () => {
  test("allows when no opt-out and DNT off", () => {
    expect(isPostHogTelemetryAllowed(storage({}), null)).toBe(true);
    expect(isPostHogTelemetryAllowed(storage({}), "0")).toBe(true);
  });

  test("blocks explicit localStorage opt-out", () => {
    expect(isPostHogTelemetryAllowed(storage({ "ocx-posthog": "0" }), null)).toBe(false);
  });

  test("blocks browser Do Not Track", () => {
    expect(isPostHogTelemetryAllowed(storage({}), "1")).toBe(false);
  });

  test("opt-out wins even when DNT is off", () => {
    expect(isPostHogTelemetryAllowed(storage({ "ocx-posthog": "0" }), "0")).toBe(false);
  });
});
