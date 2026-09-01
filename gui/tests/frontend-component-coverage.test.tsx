import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { hideRedundantChatGptForwardProviders } from "../src/provider-workspace/catalog";
import { seedDicts } from "./helpers/locales";

await seedDicts();

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
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
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    ResizeObserver: { configurable: true, value: testWindow.ResizeObserver },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testWindow.sessionStorage.clear();
  testWindow.localStorage.clear();

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

const STORAGE_SIDE_POLICY = {
  enabled: false,
  trigger: { archivedBytesOver: 5 * 1024 ** 3 },
  target: { removeOldestPercent: 25 },
  schedule: "manual",
  mode: "quarantine",
};

function mockStorageSideApis(url: string): Response | null {
  if (url.includes("/api/storage/cleanup-policy")) return Response.json(STORAGE_SIDE_POLICY);
  if (url.includes("/api/storage/trash")) return Response.json({ entries: [] });
  return null;
}

const USAGE_PAYLOAD = {
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
};

function isApiPath(url: string, path: string): boolean {
  try {
    return new URL(url, "http://localhost").pathname === path;
  } catch {
    return url.includes(path);
  }
}

function mockModelsCatalogApis(url: string): Response | null {
  if (isApiPath(url, "/api/models")) return Response.json([]);
  if (isApiPath(url, "/api/provider-context-caps")) return Response.json({ value: 350_000, caps: {} });
  if (isApiPath(url, "/api/providers")) return Response.json([]);
  if (isApiPath(url, "/api/selected-models")) return Response.json({ selected: {} });
  if (isApiPath(url, "/api/combos")) return Response.json([]);
  if (isApiPath(url, "/api/shadow-call-settings")) return Response.json({ enabled: false, model: "" });
  if (isApiPath(url, "/api/v2")) {
    return new Response(JSON.stringify({ enabled: false, multiAgentMode: "default" }), {
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

const DEMO_PROVIDER = {
  adapter: "openai-chat",
  baseUrl: "https://demo.invalid/v1",
  hasApiKey: true,
} as const;

// ─── Storage.tsx tests ───

test("Storage renders catalog backup section", async () => {
  const env = await setupEnv();
  try {
    const { default: Storage } = await import("../src/pages/Storage");
    let callCount = 0;
    mockFetch((url) => {
      callCount++;
      const side = mockStorageSideApis(url);
      if (side) return side;
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

test("Storage shows error state when the storage report fetch fails", async () => {
  const env = await setupEnv();
  try {
    const { default: Storage } = await import("../src/pages/Storage");
    mockFetch((url) => {
      const side = mockStorageSideApis(url);
      if (side) return side;
      if (url.includes("/api/storage")) return new Response("error", { status: 500 });
      return Response.json({});
    });

    await mount(env, <Storage apiBase="http://localhost" />);
    expect(env.container.textContent ?? "").toContain("Storage scan failed");
  } finally {
    await env.cleanup();
  }
});

// ─── Models.tsx tests ───

test("Models shows loading state while the catalog fetch is in flight", async () => {
  const env = await setupEnv();
  try {
    const { default: Models } = await import("../src/pages/Models");
    mockFetch((url) => {
      if (isApiPath(url, "/api/models")) return new Promise(() => {});
      const catalog = mockModelsCatalogApis(url);
      if (catalog) return catalog;
      return Response.json({});
    });

    await mount(env, <Models apiBase="http://localhost" />);
    expect(env.container.textContent ?? "").toContain("Loading");
  } finally {
    await env.cleanup();
  }
});

test("Models shows error state when catalog APIs fail", async () => {
  const env = await setupEnv();
  try {
    const { default: Models } = await import("../src/pages/Models");
    mockFetch((url) => {
      if (isApiPath(url, "/api/models")) return new Response("error", { status: 500 });
      const catalog = mockModelsCatalogApis(url);
      if (catalog) return catalog;
      return Response.json({});
    });

    await mount(env, <Models apiBase="http://localhost" />);
    expect(env.container.textContent ?? "").toContain("Failed to load models");
  } finally {
    await env.cleanup();
  }
});

test("Models renders the workspace after a successful catalog load", async () => {
  const env = await setupEnv();
  try {
    const { default: Models } = await import("../src/pages/Models");
    mockFetch((url) => {
      const catalog = mockModelsCatalogApis(url);
      if (catalog) return catalog;
      return Response.json({});
    });

    await mount(env, <Models apiBase="http://localhost" />);
    expect(env.container.querySelector("h2")?.textContent).toBe("Models");
    expect(env.container.textContent ?? "").toContain("Toggle which models Codex sees");
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
        return Response.json(USAGE_PAYLOAD);
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

test("Usage shows loading state before the first usage report arrives", async () => {
  const env = await setupEnv();
  try {
    const { default: Usage } = await import("../src/pages/Usage");
    mockFetch((url) => {
      if (url.includes("/api/usage")) return new Promise(() => {});
      if (url.includes("/healthz")) return Response.json({ status: "ok", version: "1.0.0" });
      return Response.json({});
    });

    await mount(env, <Usage apiBase="http://localhost" />);
    expect(env.container.textContent ?? "").toContain("Loading usage data");
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

test("Logs shows loading state before the first log batch arrives", async () => {
  const env = await setupEnv();
  try {
    const { default: Logs } = await import("../src/pages/Logs");
    mockFetch((url) => {
      if (url.includes("/api/logs")) return new Promise(() => {});
      return Response.json({});
    });

    await mount(env, <Logs apiBase="http://localhost" />);
    expect(env.container.textContent ?? "").toContain("Loading");
  } finally {
    await env.cleanup();
  }
});

test("Logs shows error state when the log fetch fails", async () => {
  const env = await setupEnv();
  try {
    const { default: Logs } = await import("../src/pages/Logs");
    mockFetch((url) => {
      if (url.includes("/api/logs")) return new Response("error", { status: 500 });
      return Response.json({});
    });

    await mount(env, <Logs apiBase="http://localhost" />);
    expect(env.container.textContent ?? "").toContain("Could not load request logs");
  } finally {
    await env.cleanup();
  }
});

test("Logs renders log rows after a successful fetch", async () => {
  const env = await setupEnv();
  try {
    const { default: Logs } = await import("../src/pages/Logs");
    mockFetch((url) => {
      if (url.includes("/api/logs")) {
        return Response.json([{
          timestamp: Date.now(),
          model: "gpt-4",
          provider: "openai",
          status: 200,
          durationMs: 120,
          usage: { inputTokens: 10, outputTokens: 20 },
        }]);
      }
      return Response.json({});
    });

    await mount(env, <Logs apiBase="http://localhost" />);
    expect(env.container.querySelector(".logs-table-wrap")).not.toBeNull();
    expect(env.container.textContent ?? "").not.toContain("No requests yet.");
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

test("ProviderWorkspaceShell shows usage loading skeleton on the overview dashboard", async () => {
  const env = await setupEnv();
  try {
    const { default: ProviderWorkspaceShell } = await import("../src/components/provider-workspace/ProviderWorkspaceShell");
    mockFetch((url) => {
      if (url.includes("/api/usage")) return new Promise(() => {});
      if (url.includes("/api/selected-models")) return Response.json({});
      if (url.includes("/api/provider-quotas")) return Response.json({ unsupported: true });
      return Response.json({});
    });

    await mount(env, (
      <ProviderWorkspaceShell
        providers={{ demo: DEMO_PROVIDER }}
        apiBase="http://localhost"
        defaultProvider="demo"
        selectedName={null}
        onSelect={() => {}}
        onAddProvider={() => {}}
      />
    ));

    const recent = env.container.querySelector('[aria-label="Recently used"]');
    expect(recent?.getAttribute("aria-busy")).toBe("true");
    expect(env.container.querySelector('[role="option"]')).not.toBeNull();
  } finally {
    await env.cleanup();
  }
});

test("ProviderWorkspaceShell renders overview data after usage and quota APIs succeed", async () => {
  const env = await setupEnv();
  try {
    const { default: ProviderWorkspaceShell } = await import("../src/components/provider-workspace/ProviderWorkspaceShell");
    mockFetch((url) => {
      if (url.includes("/api/usage")) {
        return Response.json({
          providers: [{ provider: "demo", requests: 4, totalTokens: 900 }],
          models: [],
        });
      }
      if (url.includes("/api/selected-models")) return Response.json({});
      if (url.includes("/api/provider-quotas")) return Response.json({ unsupported: true });
      return Response.json({});
    });

    await mount(env, (
      <ProviderWorkspaceShell
        providers={{ demo: DEMO_PROVIDER }}
        apiBase="http://localhost"
        defaultProvider="demo"
        selectedName={null}
        onSelect={() => {}}
        onAddProvider={() => {}}
      />
    ));

    expect(env.container.textContent ?? "").toContain("Demo");
    expect(env.container.textContent ?? "").toContain("4 requests");
  } finally {
    await env.cleanup();
  }
});

test("ProviderWorkspaceShell detail slot surfaces model-load failure from the API", async () => {
  const env = await setupEnv();
  try {
    const { default: ProviderWorkspaceShell } = await import("../src/components/provider-workspace/ProviderWorkspaceShell");
    mockFetch((url) => {
      if (url.includes("/api/selected-models")) return new Response("error", { status: 500 });
      if (url.includes("/api/usage")) return Response.json({ providers: [], models: [] });
      if (url.includes("/api/provider-quotas")) return Response.json({ unsupported: true });
      return Response.json({});
    });

    await mount(env, (
      <ProviderWorkspaceShell
        providers={{ demo: DEMO_PROVIDER }}
        apiBase="http://localhost"
        defaultProvider="demo"
        selectedName="demo"
        onSelect={() => {}}
        onAddProvider={() => {}}
        detail={(_item, data) => (
          <p id="pws-detail-state">
            {data.modelsLoading ? "models-loading" : data.modelsLoadFailed ? "models-error" : "models-ready"}
          </p>
        )}
      />
    ));

    expect(env.container.querySelector("#pws-detail-state")?.textContent).toBe("models-error");
  } finally {
    await env.cleanup();
  }
});

test("ProviderWorkspaceShell detail slot receives selected models after a successful fetch", async () => {
  const env = await setupEnv();
  try {
    const { default: ProviderWorkspaceShell } = await import("../src/components/provider-workspace/ProviderWorkspaceShell");
    mockFetch((url) => {
      if (isApiPath(url, "/api/selected-models")) {
        return Response.json({
          available: { demo: ["demo/claude"] },
          selected: { demo: ["demo/claude"] },
          liveModelCounts: { demo: 1 },
        });
      }
      if (url.includes("/api/usage")) return Response.json({ providers: [], models: [] });
      if (url.includes("/api/provider-quotas")) return Response.json({ unsupported: true });
      return Response.json({});
    });

    await mount(env, (
      <ProviderWorkspaceShell
        providers={{ demo: DEMO_PROVIDER }}
        apiBase="http://localhost"
        defaultProvider="demo"
        selectedName="demo"
        onSelect={() => {}}
        onAddProvider={() => {}}
        detail={(_item, data) => (
          <p id="pws-detail-state">
            {data.modelsLoading ? "models-loading" : data.modelsLoadFailed ? "models-error" : `models-ready:${data.availableModels.join(",")}`}
          </p>
        )}
      />
    ));

    expect(env.container.querySelector("#pws-detail-state")?.textContent).toBe("models-ready:demo/claude");
  } finally {
    await env.cleanup();
  }
});

test("nullish provider catalogs normalize to an empty map", () => {
  expect(hideRedundantChatGptForwardProviders(undefined)).toEqual({});
  expect(hideRedundantChatGptForwardProviders(null)).toEqual({});
});
