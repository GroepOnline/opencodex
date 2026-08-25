/**
 * Provider Models tab: optimistic single/bulk visibility toggles must roll back
 * local chip state when the server rejects the PUT.
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
  models: ["a", "b"],
  defaultModel: "a",
} as WorkspaceItem;

function mockCatalogAndCustom(visibilityStatus: number): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/custom-models")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.endsWith("/api/models")) {
      return new Response(JSON.stringify([
        { provider: "proxy", id: "a", namespaced: "proxy/a", disabled: false },
        { provider: "proxy", id: "b", namespaced: "proxy/b", disabled: false },
      ]), { status: 200 });
    }
    if (url.endsWith("/api/model-visibility") && init?.method === "PUT") {
      return new Response(JSON.stringify({ error: "rejected" }), { status: visibilityStatus });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function mount(
  renderItem: WorkspaceItem = item,
  models: string[] = ["a", "b"],
): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderModels
          item={renderItem}
          availableModels={models}
          hasLiveModels
          selectedModels={models}
          apiBase="http://localhost:10100"
        />
      </LanguageProvider>,
    );
  });
  // Flush catalog + custom-models effects.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { root, container };
}

function chipOff(container: HTMLElement, modelId: string): boolean {
  const chip = [...container.querySelectorAll("li")].find(li => li.textContent?.includes(modelId));
  return chip?.classList.contains("pws-model-chip-off") === true;
}

test("bulk All off rolls back chip state when visibility PUT fails", async () => {
  mockCatalogAndCustom(500);
  const { root, container } = await mount();
  expect(chipOff(container, "a")).toBe(false);
  expect(chipOff(container, "b")).toBe(false);

  const allOff = [...container.querySelectorAll("button")]
    .find(button => button.textContent?.trim() === "All off");
  expect(allOff).toBeTruthy();

  await act(async () => {
    allOff!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(chipOff(container, "a")).toBe(false);
  expect(chipOff(container, "b")).toBe(false);
  expect(container.textContent).toContain("Save failed");

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test("openai toggle sends native target before catalog metadata arrives", async () => {
  const putBodies: unknown[] = [];
  let releaseCatalog!: () => void;
  const catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/custom-models")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.endsWith("/api/models")) {
      // Simulate a slow catalog fetch: native metadata is not available yet
      // when the user toggles.
      await catalogGate;
      return new Response(JSON.stringify([
        { provider: "openai", id: "gpt-5", namespaced: "gpt-5", disabled: false, native: true },
      ]), { status: 200 });
    }
    if (url.endsWith("/api/model-visibility") && init?.method === "PUT") {
      putBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const openaiItem = { ...item, name: "openai", models: ["gpt-5"], defaultModel: "gpt-5" } as WorkspaceItem;
  const { root, container } = await mount(openaiItem, ["gpt-5"]);

  const switches = container.querySelectorAll("button.switch");
  expect(switches.length).toBeGreaterThan(0);

  await act(async () => {
    switches[0]!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });

  // The management API requires native=true for the "openai" provider even
  // before /api/models resolves; native=false would be rejected and roll back.
  expect(putBodies).toEqual([{
    scope: "models",
    provider: "openai",
    targets: [{ id: "gpt-5", native: true }],
    enabled: false,
  }]);
  expect(chipOff(container, "gpt-5")).toBe(true);

  releaseCatalog();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test("single toggle rolls back when visibility PUT fails", async () => {
  mockCatalogAndCustom(409);
  const { root, container } = await mount();
  expect(chipOff(container, "a")).toBe(false);

  const switches = container.querySelectorAll("button.switch");
  expect(switches.length).toBeGreaterThan(0);

  await act(async () => {
    switches[0]!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(chipOff(container, "a")).toBe(false);
  expect(container.textContent).toContain("Save failed");

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
