/**
 * Model catalog fallback: when the data-plane /v1/models rejects the GUI (401 on
 * non-loopback binds, where the dashboard only holds a management session), the
 * catalog must load through the management /api/models route instead of showing
 * a permanent "could not load" failure.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ApiKeys from "../src/pages/ApiKeys";

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let previousLanguageDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  previousLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  const previous = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    actEnv: Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
  };
  restoreGlobals = () => {
    for (const [key, descriptor] of [
      ["document", previous.document],
      ["window", previous.window],
      ["localStorage", previous.localStorage],
      ["IS_REACT_ACT_ENVIRONMENT", previous.actEnv],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    if (previousLanguageDescriptor) {
      Object.defineProperty(globalThis.navigator, "language", previousLanguageDescriptor);
    } else {
      delete (globalThis.navigator as { language?: string }).language;
    }
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreGlobals?.();
});

const KEYS_OK = {
  keys: [],
  baseUrl: "http://127.0.0.1:10100/v1",
  endpoint: "http://127.0.0.1:10100/v1/responses",
  claudeCodeEnabled: true,
};

const ADMIN_MODELS = [
  { provider: "openai", id: "gpt-5.4", namespaced: "gpt-5.4", disabled: false, native: true },
  { provider: "gemini", id: "flash", namespaced: "gemini/flash", disabled: false },
  { provider: "openai", id: "gpt-old", namespaced: "gpt-old", disabled: true, native: true },
  { provider: "grok", id: "dead", namespaced: "grok/dead", disabled: false, clientHidden: true },
];

test("catalog falls back to /api/models when /v1/models rejects the GUI", async () => {
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  let adminModelsGets = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/v1/models")) {
      return Response.json({ error: { message: "opencodex API key required" } }, { status: 401 });
    }
    if (url.endsWith("/api/models") && method === "GET") {
      adminModelsGets += 1;
      return Response.json(ADMIN_MODELS);
    }
    if (url.endsWith("/api/keys") && method === "GET") {
      return Response.json(KEYS_OK);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <LanguageProvider>
          <ApiKeys apiBase="http://localhost" />
        </LanguageProvider>,
      );
    });
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });

    expect(adminModelsGets).toBe(1);
    expect(container.textContent).toContain("gpt-5.4");
    expect(container.textContent).toContain("gemini/flash");
    // Disabled / client-hidden rows are not externally callable.
    expect(container.textContent).not.toContain("gpt-old");
    expect(container.textContent).not.toContain("grok/dead");
    expect(container.textContent).not.toContain("Could not load the external model catalog.");
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});
