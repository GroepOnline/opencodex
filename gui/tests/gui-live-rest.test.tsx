import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Dashboard from "../src/pages/Dashboard";
import { seedDicts } from "./helpers/locales";

await seedDicts();

test("Startup mounts MemoryObservabilityCard on the live systeem page", async () => {
  const src = await Bun.file(new URL("../src/pages/Startup.tsx", import.meta.url)).text();
  expect(src).toContain('import MemoryObservabilityCard from "../components/MemoryObservabilityCard"');
  expect(src).toContain("<MemoryObservabilityCard apiBase={apiBase} />");
});

test("Providers quota mutations bump the live workspace refresh key", async () => {
  const page = await Bun.file(new URL("../src/pages/Providers.tsx", import.meta.url)).text();
  const fetchHook = await Bun.file(new URL("../src/pages/use-providers-fetch.ts", import.meta.url)).text();
  expect(page).not.toContain("setQuotaReports");
  expect(page).toContain("setQuotaEpoch");
  expect(page).toContain("String(quotaEpoch)");
  expect(page).toContain("quotaRefreshKey={quotaRefreshKey}");
  expect(fetchHook).not.toContain("fetchProviderQuotas");
  expect(fetchHook).not.toContain("setQuotaReports");
  expect(fetchHook).not.toContain("/api/provider-quotas");
});

test("Usage polls the management API while the tab is visible", async () => {
  const src = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  expect(src).toContain("window.setInterval");
  expect(src).toContain("30_000");
  expect(src).toContain('document.visibilityState === "hidden"');
  expect(src).toContain("/api/usage?range=");
});

test("dead page-level use-provider-quotas hook stays deleted", async () => {
  expect(await Bun.file(new URL("../src/use-provider-quotas.ts", import.meta.url)).exists()).toBe(false);
});

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
    });
  }
}

test("Dashboard surfaces usage and logs fetch errors", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/healthz")) {
      return Response.json({
        status: "ok",
        service: "opencodex",
        version: "1.2.2",
        uptime: 12,
        pid: 7,
        port: 1455,
      });
    }
    if (url.includes("/api/usage") || url.includes("/api/logs")) {
      return new Response("nope", { status: 500 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Dashboard apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });

  await waitFor(() => (container.textContent ?? "").includes("Could not load usage data."));
  expect(container.textContent).toContain("Could not load traffic. Last known rows stay visible.");

  await act(async () => { root.unmount(); });
  container.remove();
});
