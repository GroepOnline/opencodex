import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Startup from "../src/pages/Startup";
import Usage from "../src/pages/Usage";

import { seedDicts } from "./helpers/locales";

await seedDicts();

/**
 * Storage already has this coverage (storage-loading-race.test.tsx). Startup and Usage carry the
 * same generation-ownership guard but had no regression of their own, so either could lose it
 * silently. The shape is identical: start a replacement request, then settle the superseded one
 * afterwards and assert it neither clears loading nor installs its stale payload.
 */
const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  Object.defineProperty(testWindow, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  });
}

type Gate = { resolve: (body: unknown) => void };

test("an aborted Startup fetch must not clear loading while its replacement is in flight", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const gates: Gate[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    // Only the primary health call is gated; the follow-up calls resolve immediately so the
    // test observes the generation guard rather than incidental request ordering.
    if (!url.includes("/api/startup-health")) return new Response(null, { status: 404 });
    const body = await new Promise<unknown>(resolve => { gates.push({ resolve }); });
    return Response.json(body);
  }) as typeof fetch;

  const health = (recommendedCommand: string) => ({
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
    platform: "darwin",
    recommendedCommand,
    diagnosticStale: false,
    commands: { installService: "ocx service install", installShim: "ocx shim install", restoreNative: "ocx restore" },
  });
  const STALE = health("stale-startup-marker");
  const FRESH = health("fresh-startup-marker");

  function Harness() {
    const [apiBase, setApiBase] = useState("http://old");
    (window as unknown as { __bumpApiBase?: () => void }).__bumpApiBase = () => setApiBase("http://new");
    return (
      <LanguageProvider>
        <Startup apiBase={apiBase} />
      </LanguageProvider>
    );
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });
  await settle();
  await waitFor(() => gates.length === 1);

  await act(async () => {
    (window as unknown as { __bumpApiBase: () => void }).__bumpApiBase();
  });
  await settle();
  await waitFor(() => gates.length === 2);

  // The superseded request answers only now, after its replacement already started.
  await act(async () => {
    gates[0]!.resolve(STALE);
    await Promise.resolve();
  });
  await settle();

  expect(container.textContent).toContain("Checking startup protection");
  const refresh = container.querySelector<HTMLButtonElement>("button.btn");
  expect(refresh?.disabled).toBe(true);

  await act(async () => {
    gates[1]!.resolve(FRESH);
    await Promise.resolve();
  });
  await waitFor(() => !(container.textContent ?? "").includes("Checking startup protection"));
  expect(refresh?.disabled).toBe(false);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("an aborted Usage fetch must not clear loading while its replacement is in flight", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const gates: Gate[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("/api/usage")) return new Response(null, { status: 404 });
    const body = await new Promise<unknown>(resolve => { gates.push({ resolve }); });
    return Response.json(body);
  }) as typeof fetch;

  const summary = {
    requests: 0, measuredRequests: 0, reportedRequests: 0, unreportedRequests: 0,
    unsupportedRequests: 0, estimatedRequests: 0, inputTokens: 0, outputTokens: 0,
    cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, coverageRatio: 1,
  };
  const usage = (generatedAt: number) => ({
    range: "7d", surface: "all", since: null, generatedAt,
    summary, days: [], models: [], providers: [],
  });
  const STALE = usage(1);
  const FRESH = usage(2);

  function Harness() {
    const [apiBase, setApiBase] = useState("http://old");
    (window as unknown as { __bumpApiBase?: () => void }).__bumpApiBase = () => setApiBase("http://new");
    return (
      <LanguageProvider>
        <Usage apiBase={apiBase} />
      </LanguageProvider>
    );
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });
  await settle();
  await waitFor(() => gates.length === 1);

  await act(async () => {
    (window as unknown as { __bumpApiBase: () => void }).__bumpApiBase();
  });
  await settle();
  await waitFor(() => gates.length === 2);

  await act(async () => {
    gates[0]!.resolve(STALE);
    await Promise.resolve();
  });
  await settle();

  // Unconditional clearing would drop this while request #2 is still outstanding.
  expect(container.textContent).toContain("Loading usage data");

  await act(async () => {
    gates[1]!.resolve(FRESH);
    await Promise.resolve();
  });
  await waitFor(() => !(container.textContent ?? "").includes("Loading usage data"));

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a failed Usage refresh keeps last-good data on screen", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  let call = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("/api/usage")) return new Response(null, { status: 404 });
    call += 1;
    if (call === 1) {
      return Response.json({
        range: "30d",
        surface: "all",
        since: null,
        generatedAt: 1,
        summary: {
          requests: 42,
          measuredRequests: 42,
          reportedRequests: 42,
          unreportedRequests: 0,
          unsupportedRequests: 0,
          estimatedRequests: 0,
          inputTokens: 100,
          outputTokens: 200,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 300,
          coverageRatio: 1,
        },
        days: [],
        models: [],
        providers: [],
      });
    }
    return new Response(null, { status: 503 });
  }) as typeof fetch;

  function Harness() {
    const [apiBase, setApiBase] = useState("http://old");
    (window as unknown as { __bumpApiBase?: () => void }).__bumpApiBase = () => setApiBase("http://new");
    return (
      <LanguageProvider>
        <Usage apiBase={apiBase} />
      </LanguageProvider>
    );
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });
  await settle();
  await waitFor(() => (container.textContent ?? "").includes("42"));

  await act(async () => {
    (window as unknown as { __bumpApiBase: () => void }).__bumpApiBase();
  });
  await settle();
  await waitFor(() => call >= 2);

  expect(container.textContent).toContain("42");
  expect(container.textContent).not.toContain("Could not load usage data");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("Usage shows an error when the first load fails with no data", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("/api/usage")) return new Response(null, { status: 404 });
    return new Response(null, { status: 503 });
  }) as typeof fetch;

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Usage apiBase="http://test" />
      </LanguageProvider>,
    );
  });
  await settle();
  await waitFor(() => (container.textContent ?? "").includes("Could not load usage data"));

  expect(container.textContent).toContain("Retry");

  await act(async () => { root.unmount(); });
  container.remove();
});
