import { describe, expect, it } from "bun:test";
import { getServerPosthog, resetServerPosthog, TELEMETRY_EVENTS } from "../src/telemetry/posthog-server";

describe("getServerPosthog", () => {
  it("returns null when OCX_POSTHOG_KEY is unset", () => {
    delete process.env["OCX_POSTHOG_KEY"];
    resetServerPosthog();
    expect(getServerPosthog()).toBeNull();
  });

  it("returns a client when OCX_POSTHOG_KEY is set", () => {
    process.env["OCX_POSTHOG_KEY"] = "test-key";
    resetServerPosthog();
    const client = getServerPosthog();
    expect(client).not.toBeNull();
    client!.shutdown();
  });

  it("TELEMETRY_EVENTS has stable event names", () => {
    expect(TELEMETRY_EVENTS.REQUEST_TERMINAL).toBe("proxy_request_terminal");
    expect(TELEMETRY_EVENTS.BUDGET_EXCEEDED).toBe("proxy_budget_exceeded");
    expect(TELEMETRY_EVENTS.FAILOVER_TRIGGERED).toBe("proxy_failover_triggered");
  });
});
