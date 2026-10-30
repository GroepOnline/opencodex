import { describe, expect, test } from "bun:test";
import { datadogBrowserLog, datadogBrowserLogsUrl } from "../src/datadog";

describe("dashboard Datadog client", () => {
  test("builds an EU browser intake URL for a client token", () => {
    const url = datadogBrowserLogsUrl("app.datadoghq.eu", "pubclient");
    expect(url).toBe(
      "https://browser-intake-datadoghq.eu/api/v2/logs?ddsource=browser&dd-api-key=pubclient&dd-evp-origin=browser",
    );
  });

  test("rejects an unknown site and a short token", () => {
    expect(
      datadogBrowserLogsUrl("https://evil.example", "pubclient"),
    ).toBeUndefined();
    expect(datadogBrowserLogsUrl("datadoghq.eu", "short")).toBeUndefined();
    expect(datadogBrowserLogsUrl("datadoghq.eu", "")).toBeUndefined();
  });

  test("log bodies are fixed messages", () => {
    expect(datadogBrowserLog("unexpected_failure")).toEqual({
      ddsource: "browser",
      service: "opencodex-gui",
      hostname: "opencodex",
      message: "unexpected_failure",
      status: "error",
    });
  });
});
