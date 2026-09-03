import { expect, test } from "bun:test";

test("landing returns before the dashboard health resource is mounted", async () => {
  const source = await Bun.file(
    new URL("../src/App.tsx", import.meta.url),
  ).text();
  const landingGuard = source.indexOf('if (route.view === "landing")');
  const shellCall = source.indexOf("<DashboardShell");
  const shell = source.indexOf("function DashboardShell");
  const healthResource = source.indexOf(
    "const healthPoll = useKeyedClientResource",
    shell,
  );

  expect(landingGuard).toBeGreaterThan(-1);
  expect(shellCall).toBeGreaterThan(landingGuard);
  expect(shell).toBeGreaterThan(shellCall);
  expect(healthResource).toBeGreaterThan(shell);

  const landingBlock = source.slice(landingGuard, shellCall);
  expect(landingBlock).toContain("<ErrorBoundary");
  expect(landingBlock).toContain("<Suspense");
  expect(landingBlock.indexOf("<ErrorBoundary")).toBeLessThan(
    landingBlock.indexOf("<Suspense"),
  );
  expect(landingBlock).not.toContain("useKeyedClientResource");
});

test("landing terminal binds its version to the build-time package version", async () => {
  const landing = await Bun.file(
    new URL("../src/landing/Landing.tsx", import.meta.url),
  ).text();
  const en = await Bun.file(
    new URL("../src/i18n/en.ts", import.meta.url),
  ).text();
  const nl = await Bun.file(
    new URL("../src/i18n/nl.ts", import.meta.url),
  ).text();

  const proxyCall = landing.slice(
    landing.indexOf('t("landing.terminal.proxyListening"'),
    landing.indexOf('t("landing.terminal.proxyListening"') + 180,
  );
  expect(proxyCall).toContain("version: __APP_VERSION__");
  const enProxy = en.slice(
    en.indexOf('"landing.terminal.proxyListening"'),
    en.indexOf('"landing.terminal.proxyListening"') + 180,
  );
  const nlProxy = nl.slice(
    nl.indexOf('"landing.terminal.proxyListening"'),
    nl.indexOf('"landing.terminal.proxyListening"') + 180,
  );
  expect(enProxy).toContain("opencodex {version} · proxy listening");
  expect(nlProxy).toContain("opencodex {version} · proxy luistert");
  expect(en).not.toMatch(
    /landing\.terminal\.proxyListening.*opencodex \d+\.\d+\.\d+/,
  );
  expect(nl).not.toMatch(
    /landing\.terminal\.proxyListening.*opencodex \d+\.\d+\.\d+/,
  );
});
