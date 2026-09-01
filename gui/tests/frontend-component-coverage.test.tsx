import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { hideRedundantChatGptForwardProviders } from "../src/provider-workspace/catalog";
import { seedDicts } from "./helpers/locales";

await seedDicts();

const globals = ["document", "window", "navigator", "localStorage", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
type GlobalsKey = (typeof globals)[number];

interface TestEnv {
  testWindow: Window;
  root: Root;
  container: HTMLElement;
}

/**
 * Set up a fresh happy-dom environment for a single test.
 * Captures the current globals so they can be restored in cleanup.
 * Call the returned cleanup() in a finally block to guarantee restoration
 * even if the test throws — preventing global state leaking into other files.
 */
async function setupEnv(): Promise<TestEnv & { cleanup: () => Promise<void> }> {
  const previousGlobalDescriptors = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<GlobalsKey, PropertyDescriptor | undefined>;

  const originalFetch = globalThis.fetch;

  const testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    ResizeObserver: { configurable: true, value: testWindow.ResizeObserver },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  return {
    testWindow,
    root,
    container,
    cleanup: async () => {
      globalThis.fetch = originalFetch;
      await act(async () => { root.unmount(); });
      container.remove();
      testWindow.close();
      for (const key of globals) {
        const descriptor = previousGlobalDescriptors[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

async function mount(env: TestEnv, element: React.ReactElement): Promise<void> {
  await act(async () => {
    env.root.render(<LanguageProvider>{element}</LanguageProvider>);
  });
  // Let effects settle
  await act(async () => {
    await new Promise<void>(resolve => env.testWindow.setTimeout(resolve, 10));
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    return handler(url, init);
  }) as typeof fetch;
}

// ─── Storage.tsx tests ───

test("Storage renders catalog backup section", async () => {
  const env = await setupEnv();
  try {
    const { default: Storage } = await import("../src/pages/Storage");
    let callCount = 0;
    mockFetch((url) => {
      callCount++;
      if (url.includes("/api/storage")) {
        return Response.json({
          codexHome: "/home/user/.codex",
          generatedAt: Date.now(),
          total: { bytes: 0, fileCount: 0 },
          buckets: [],
        });
      }
      return Response.json({});
    });

    await mount(env, <Storage apiBase="http://localhost" />);
    expect(env.container.querySelector("#storage-page-title")?.textContent).toBe("Storage");
    expect(env.container.textContent ?? "").toContain("Diagnostics for CODEX_HOME disk use.");
    expect(callCount).toBeGreaterThan(0);
  } finally {
    await env.cleanup();
  }
});

test("Storage shows loading state initially", async () => {
  const env = await setupEnv();
  try {
    const { default: Storage } = await import("../src/pages/Storage");
    mockFetch(() => new Promise(() => {})); // never resolves

    await mount(env, <Storage apiBase="http://localhost" />);
    // With no cached report and an in-flight fetch, Storage renders the
    // "Scanning storage…" EmptyState (gui/src/pages/Storage.tsx loading branch).
    expect(env.container.textContent ?? "").toContain("Scanning storage");
  } finally {
    await env.cleanup();
  }
});

// ─── Usage.tsx tests ───

test("Usage renders usage report panels", async () => {
  const env = await setupEnv();
  try {
    const { default: Usage } = await import("../src/pages/Usage");
    mockFetch((url) => {
      if (url.includes("/api/usage")) {
        return Response.json({
          range: "7d",
          surface: "all",
          since: null,
          generatedAt: Date.now(),
          summary: {
            requests: 3,
            measuredRequests: 3,
            reportedRequests: 3,
            unreportedRequests: 0,
            unsupportedRequests: 0,
            estimatedRequests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
            coverageRatio: 0,
          },
          days: [],
          models: [],
          providers: [],
        });
      }
      if (url.includes("/healthz")) {
        return Response.json({ status: "ok", version: "1.0.0" });
      }
      return Response.json({});
    });

    await mount(env, <Usage apiBase="http://localhost" />);
    expect(env.container.querySelector("#usage-quality-title")?.textContent).toBe("Request quality");
    expect(env.container.querySelector('[role="group"][aria-label="Proxy usage"]')).not.toBeNull();
  } finally {
    await env.cleanup();
  }
});

test("Usage handles fetch error gracefully", async () => {
  const env = await setupEnv();
  try {
    const { default: Usage } = await import("../src/pages/Usage");
    mockFetch(() => new Response("error", { status: 500 }));

    await mount(env, <Usage apiBase="http://localhost" />);
    // Should render error state, not crash
    const text = env.container.textContent ?? "";
    expect(text).toContain("Could not load usage data");
  } finally {
    await env.cleanup();
  }
});

// ─── Logs.tsx tests ───

test("Logs renders log viewer with tabs", async () => {
  const env = await setupEnv();
  try {
    const { default: Logs } = await import("../src/pages/Logs");
    mockFetch((url) => {
      if (url.includes("/api/logs")) {
        // /api/logs returns a bare array (src/server/management/logs-usage-routes.ts).
        return Response.json([]);
      }
      return Response.json({});
    });

    await mount(env, <Logs apiBase="http://localhost" />);
    const tabs = env.container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(2);
    expect(tabs[0]?.textContent).toBe("Logs");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.textContent).toBe("Debug");
  } finally {
    await env.cleanup();
  }
});

test("Logs shows empty state when no logs", async () => {
  const env = await setupEnv();
  try {
    const { default: Logs } = await import("../src/pages/Logs");
    mockFetch((url) => {
      if (url.includes("/api/logs")) {
        // /api/logs returns a bare array (src/server/management/logs-usage-routes.ts).
        return Response.json([]);
      }
      return Response.json({});
    });

    await mount(env, <Logs apiBase="http://localhost" />);
    expect(env.container.textContent ?? "").toContain("No requests yet.");
  } finally {
    await env.cleanup();
  }
});

// ─── ProviderWorkspaceShell.tsx tests ───

test("ProviderWorkspaceShell renders an explicit empty state when no providers exist", async () => {
  const env = await setupEnv();
  try {
    const { default: ProviderWorkspaceShell } = await import("../src/components/provider-workspace/ProviderWorkspaceShell");

    await mount(env, (
      <ProviderWorkspaceShell
        providers={{}}
        apiBase="http://localhost"
        defaultProvider=""
        selectedName={null}
        onSelect={() => {}}
        onAddProvider={() => {}}
      />
    ));

    expect(env.container.querySelector("h2")?.textContent).toBe("Connect your first provider");
    expect(env.container.querySelectorAll("button").length).toBe(3);
  } finally {
    await env.cleanup();
  }
});

test("nullish provider catalogs normalize to an empty map", () => {
  expect(hideRedundantChatGptForwardProviders(undefined)).toEqual({});
  expect(hideRedundantChatGptForwardProviders(null)).toEqual({});
});
