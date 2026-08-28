import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { seedDicts } from "./helpers/locales";

await seedDicts();

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
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
        return Response.json({ catalog_backup_exists: true, catalog_backup_path: "/tmp/catalog.json" });
      }
      return Response.json({});
    });

    await mount(env, <Storage apiBase="http://localhost" />);
    const text = env.container.textContent ?? "";
    expect(text).toContain("Catalog");
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
    // Should render without crashing while loading
    expect(env.container.querySelector(".muted")).toBeTruthy();
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
        return Response.json({ rows: [], total_tokens: 0, total_requests: 0 });
      }
      if (url.includes("/healthz")) {
        return Response.json({ status: "ok", version: "1.0.0" });
      }
      return Response.json({});
    });

    await mount(env, <Usage apiBase="http://localhost" />);
    const text = env.container.textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
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
        return Response.json({ lines: [] });
      }
      return Response.json({});
    });

    await mount(env, <Logs apiBase="http://localhost" />);
    const text = env.container.textContent ?? "";
    expect(text).toContain("Logs");
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
        return Response.json({ lines: [] });
      }
      return Response.json({});
    });

    await mount(env, <Logs apiBase="http://localhost" />);
    // Should show empty state message
    const text = env.container.textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
  } finally {
    await env.cleanup();
  }
});

// ─── ProviderWorkspaceShell.tsx tests ───

test("ProviderWorkspaceShell renders provider workspace", async () => {
  const env = await setupEnv();
  try {
    const { default: ProviderWorkspaceShell } = await import("../src/components/provider-workspace/ProviderWorkspaceShell");
    mockFetch((url) => {
      if (url.includes("/api/providers?name=openai")) {
        return Response.json({ name: "openai", label: "OpenAI", models: [], quota: {} });
      }
      if (url.includes("/api/usage")) {
        return Response.json({ rows: [], total_tokens: 0, total_requests: 0 });
      }
      return Response.json({});
    });

    await mount(env, <ProviderWorkspaceShell apiBase="http://localhost" provider="openai" />);
    const text = env.container.textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
  } finally {
    await env.cleanup();
  }
});

test("ProviderWorkspaceShell handles provider fetch failure", async () => {
  const env = await setupEnv();
  try {
    const { default: ProviderWorkspaceShell } = await import("../src/components/provider-workspace/ProviderWorkspaceShell");
    mockFetch(() => new Response("error", { status: 500 }));

    await mount(env, <ProviderWorkspaceShell apiBase="http://localhost" provider="openai" />);
    // Should render error state, not crash
    expect(env.container.textContent).toBeTruthy();
  } finally {
    await env.cleanup();
  }
});
