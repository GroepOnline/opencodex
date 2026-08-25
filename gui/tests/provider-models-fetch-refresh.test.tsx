/**
 * Provider Models tab: Fetch models must hit the per-provider refresh
 * endpoint, not the global /api/sync catalog rebuild.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderModels from "../src/components/provider-workspace/ProviderModels";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

import { seedDicts } from "./helpers/locales";

await seedDicts();

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
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

const item = {
  name: "proxy",
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  models: ["a"],
  defaultModel: "a",
} as WorkspaceItem;

test("Fetch models posts to the per-provider refresh route", async () => {
  const posted: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/custom-models")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.endsWith("/api/models")) {
      return new Response(JSON.stringify([
        { provider: "proxy", id: "a", namespaced: "proxy/a", disabled: false },
      ]), { status: 200 });
    }
    if (init?.method === "POST") posted.push(url);
    if (url.includes("/api/providers/models/refresh")) {
      return new Response(JSON.stringify({
        ok: true,
        provider: "proxy",
        count: 2,
        models: ["a", "b"],
        source: "live",
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderModels
          item={item}
          availableModels={["a"]}
          hasLiveModels
          selectedModels={["a"]}
          apiBase="http://localhost:10100"
        />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const fetchBtn = [...container.querySelectorAll("button")]
    .find(button => button.textContent?.trim() === "Fetch models");
  expect(fetchBtn).toBeTruthy();

  await act(async () => {
    fetchBtn!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(posted.some(url => url.includes("/api/providers/models/refresh?name=proxy"))).toBe(true);
  expect(posted.some(url => url.endsWith("/api/sync"))).toBe(false);
  expect(container.textContent).toContain("Fetched 2 models from proxy.");

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
