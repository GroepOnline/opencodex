import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nContext, interpolate } from "../src/i18n/shared";
import { en } from "../src/i18n/en";
import { StartupHealthTable } from "../src/pages/startup-health-table";
import type { StartupHealthData } from "../src/pages/startup-shared";
const data: StartupHealthData = {
  status: "protected",
  routingKind: "opencodex-local",
  routingInjected: true,
  localRoutingDependency: true,
  autostartEnabled: true,
  rebootSafe: true,
  protection: "service",
  serviceInstalled: true,
  serviceViable: true,
  serviceEnabled: true,
  serviceRunning: true,
  serviceStale: false,
  serviceConflict: false,
  serviceSupported: true,
  shimInstalled: true,
  shimHealthy: true,
  shimCoverage: "full",
  platform: "linux",
  recommendedCommand: null,
  diagnosticStale: false,
  commands: { installService: "", installShim: "", restoreNative: "" },
};
function render(overrides: Partial<StartupHealthData> = {}, failed = false) {
  return renderToStaticMarkup(
    <I18nContext.Provider
      value={{
        locale: "en",
        setLocale: () => {},
        t: (key, vars) => interpolate(en[key], vars),
      }}
    >
      <StartupHealthTable
        data={{ ...data, ...overrides }}
        failed={failed}
        proxyVersion="fixture"
        proxyUptime={1}
        proxyOnline={true}
        tray={null}
        trayLoading={false}
        trayError={false}
      />
    </I18nContext.Provider>,
  );
}
function row(markup: string, label: string) {
  return (
    markup.split("<tr>").find((part) => part.startsWith(`<td>${label}</td>`)) ??
    ""
  );
}
test("missing persistence and tray discovery never claim healthy", () => {
  expect(row(render(), "Persistence")).toContain("badge-status-unknown");
  expect(row(render({ platform: "win32" }), "Windows tray")).toContain(
    "badge-status-unknown",
  );
});
test("failed or stale diagnostics do not keep service and shim green", () => {
  for (const markup of [render({}, true), render({ diagnosticStale: true })]) {
    expect(row(markup, "Restart protection")).toContain("badge-status-unknown");
    expect(row(markup, "Autostart shim")).toContain("badge-status-unknown");
    expect(row(markup, "Proxy")).toContain("badge-status-healthy");
  }
});
