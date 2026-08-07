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

  test("allows telemetry when storage is null (privacy-preserving fallback)", () => {
    expect(isPostHogTelemetryAllowed(null, null)).toBe(true);
    expect(isPostHogTelemetryAllowed(null, "0")).toBe(true);
  });

  test("blocks telemetry when storage is null and DNT is on", () => {
    expect(isPostHogTelemetryAllowed(null, "1")).toBe(false);
  });

  test("allows telemetry when storage throws (privacy-preserving fallback)", () => {
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
    };
    expect(isPostHogTelemetryAllowed(throwing, null)).toBe(true);
    expect(isPostHogTelemetryAllowed(throwing, "0")).toBe(true);
  });

  test("blocks telemetry when storage throws and DNT is on", () => {
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
    };
    expect(isPostHogTelemetryAllowed(throwing, "1")).toBe(false);
  });
});
