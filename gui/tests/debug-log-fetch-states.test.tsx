import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Debug from "../src/pages/Debug";
import type { DebugSettings } from "../src/pages/debug-shared";
import { seedDicts } from "./helpers/locales";

await seedDicts();

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
  "ResizeObserver",
] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const roots: Root[] = [];
const originalFetch = globalThis.fetch;

const SETTINGS: DebugSettings = {
  enabled: true,
  usage: false,
  injection: false,
  claude: false,
  runtimeOverride: {},
  env: { debug: true, usage: false, injection: false, claude: false },
};

function installLayoutStubs(win: Window): void {
  const proto = win.HTMLElement.prototype as unknown as HTMLElement;
  for (const property of ["clientHeight", "offsetHeight"] as const) {
    Object.defineProperty(proto, property, {
      configurable: true,
      get: () => 800,
    });
  }
  for (const property of ["clientWidth", "offsetWidth"] as const) {
    Object.defineProperty(proto, property, {
      configurable: true,
      get: () => 1200,
    });
  }
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value() {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 800,
        right: 1200,
        width: 1200,
        height: 800,
        toJSON() {
          return this;
        },
      };
    },
  });
  class ResizeObserverStub {
    constructor(_callback: ResizeObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
  Object.defineProperty(win, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(
    globals.map((key) => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#debug" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  installLayoutStubs(testWindow);
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  globalThis.fetch = originalFetch;
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  testWindow.close();
  clearClientResourceStoresForTests();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: previousGlobals[key],
    });
  }
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_500,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 10));
    });
  }
}

test("Debug distinguishes first log failure, retry, and retained-row refresh failure", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let response: "failure" | "first" | "refreshFailure" | "recovered" =
    "failure";

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/debug")) return Response.json(SETTINGS);
    if (url.includes("/api/debug/logs")) {
      if (response === "failure" || response === "refreshFailure")
        return new Response(null, { status: 503 });
      return Response.json([
        {
          seq: response === "first" ? 1 : 2,
          at: 1_700_000_000_000,
          line: response === "first" ? " first line" : " recovered line",
        },
      ]);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    roots.push(root);
    root.render(
      <LanguageProvider>
        <Debug apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });

  await waitFor(() => Boolean(container.querySelector('[role="alert"]')));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Retry",
  );
  expect(container.textContent).not.toContain("Waiting for lines");

  response = "first";
  await act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Retry")
      ?.click();
  });
  await waitFor(() => container.textContent?.includes("first line") ?? false);

  response = "refreshFailure";
  await act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Refresh"))
      ?.click();
  });
  await waitFor(() => Boolean(container.querySelector('[role="alert"]')));
  expect(container.textContent).toContain("first line");

  response = "recovered";
  await act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Refresh"))
      ?.click();
  });
  await waitFor(
    () => container.textContent?.includes("recovered line") ?? false,
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

async function mountDebug(settings: DebugSettings | null = SETTINGS) {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (active: boolean, apiBase = "http://localhost") => {
    await act(async () =>
      root.render(
        <LanguageProvider>
          <Debug apiBase={apiBase} active={active} />
        </LanguageProvider>,
      ),
    );
  };
  // Seed settings to observe the first log request independently from settings loading.
  const { setClientResourceData } = await import("../src/client-resource");
  if (settings)
    setClientResourceData("debug-settings:http://localhost", settings);
  await render(true);
  return { container, render };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Debug first loading never claims a successful empty stream", async () => {
  const pending = deferred<Response>();
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).endsWith("/api/debug")
      ? Response.json(SETTINGS)
      : pending.promise) as typeof fetch;
  const { container } = await mountDebug();
  expect(container.textContent).not.toContain("Waiting for lines");
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => pending.resolve(Response.json([])));
  await waitFor(
    () => container.textContent?.includes("Waiting for lines") ?? false,
  );
});

test("Debug retains a successful empty snapshot during failed refresh and accepts an empty replacement", async () => {
  let result: "empty" | "line" | "failure" = "empty";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/debug")) return Response.json(SETTINGS);
    if (result === "failure") throw new TypeError("network failure");
    return Response.json(
      result === "line" ? [{ seq: 1, at: 0, line: "original line" }] : [],
    );
  }) as typeof fetch;
  const { container } = await mountDebug();
  await waitFor(
    () => container.textContent?.includes("Waiting for lines") ?? false,
  );
  result = "failure";
  await act(async () => button(container, "Refresh").click());
  await waitFor(() => Boolean(container.querySelector('[role="alert"]')));
  expect(container.textContent).toContain("Waiting for lines");
  result = "line";
  await act(async () => button(container, "Refresh").click());
  await waitFor(
    () => container.textContent?.includes("original line") ?? false,
  );
  result = "empty";
  await act(async () => button(container, "Refresh").click());
  await waitFor(
    () => container.textContent?.includes("Waiting for lines") ?? false,
  );
  expect(container.textContent).not.toContain("original line");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("Debug ignores a late failed response from the previous stream", async () => {
  const provider = deferred<Response>();
  const requests: string[] = [];
  const settings = { ...SETTINGS, usage: true };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/debug")) return Response.json(settings);
    requests.push(url);
    if (url.includes("/api/debug/logs")) return provider.promise;
    return Response.json([{ seq: 10, at: 0, line: "usage line" }]);
  }) as typeof fetch;
  const { container } = await mountDebug(settings);
  await waitFor(() => requests.some((url) => url.includes("/api/debug/logs")));
  await act(async () => button(container, "Usage").click());
  await waitFor(() => container.textContent?.includes("usage line") ?? false);
  await act(async () => provider.resolve(new Response(null, { status: 503 })));
  expect(container.textContent).toContain("usage line");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(requests.find((url) => url.includes("usage-logs"))).not.toContain(
    "after=",
  );
});

function controlLogPolling(intervalMs = 1000) {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const ticks = new Map<ReturnType<typeof setInterval>, () => void>();
  const setSpy = spyOn(globalThis, "setInterval").mockImplementation(
    (callback, delay, ...args) => {
      const id = originalSetInterval(
        callback,
        delay === intervalMs ? 60_000 : delay,
        ...args,
      );
      if (delay === intervalMs) ticks.set(id, () => callback(...args));
      return id;
    },
  );
  const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation(
    (id) => {
      if (id !== undefined) ticks.delete(id);
      originalClearInterval(id);
    },
  );
  return {
    ticks,
    tick: async () => {
      await act(async () => {
        for (const tick of ticks.values()) tick();
      });
    },
    restore: () => {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    },
  };
}

test("Debug serializes slow polls and retries with the last accepted cursor", async () => {
  const polling = controlLogPolling();
  const pending = deferred<Response>();
  const requests: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/debug") return Response.json(SETTINGS);
    requests.push(url);
    if (requests.length === 2) return pending.promise;
    return Response.json([
      {
        seq: requests.length === 1 ? 10 : 11,
        at: 0,
        line: requests.length === 1 ? "original line" : "recovered line",
      },
    ]);
  }) as typeof fetch;
  try {
    const { container } = await mountDebug();
    await waitFor(
      () => container.textContent?.includes("original line") ?? false,
    );
    await polling.tick();
    await polling.tick();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.searchParams.get("after")).toBe("10");
    await act(async () => pending.resolve(new Response(null, { status: 503 })));
    expect(container.textContent).toContain("original line");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => button(container, "Retry").click());
    await waitFor(
      () => container.textContent?.includes("recovered line") ?? false,
    );
    expect(requests[2]?.searchParams.get("after")).toBe("10");
    expect(container.textContent).toContain("original line");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    polling.restore();
  }
});

test("Debug pauses polling and cancels pending work while inactive without dropping accepted lines", async () => {
  const polling = controlLogPolling();
  const pending = deferred<Response>();
  const requests: URL[] = [];
  let pendingSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/debug") return Response.json(SETTINGS);
    requests.push(url);
    if (requests.length === 2) {
      pendingSignal = init?.signal;
      return pending.promise;
    }
    return Response.json([
      {
        seq: requests.length === 1 ? 10 : 11,
        at: 0,
        line: requests.length === 1 ? "accepted line" : "resumed line",
      },
    ]);
  }) as typeof fetch;
  try {
    const { container, render } = await mountDebug();
    await waitFor(
      () => container.textContent?.includes("accepted line") ?? false,
    );
    await polling.tick();
    await render(false);
    expect(polling.ticks.size).toBe(0);
    expect(pendingSignal?.aborted).toBe(true);
    await act(async () =>
      pending.resolve(Response.json([{ seq: 99, at: 0, line: "late line" }])),
    );
    expect(container.textContent).not.toContain("late line");
    await render(true);
    await polling.tick();
    await waitFor(
      () => container.textContent?.includes("resumed line") ?? false,
    );
    expect(requests[2]?.searchParams.get("after")).toBe("10");
    expect(container.textContent).toContain("accepted line");
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.click(),
    );
    expect(polling.ticks.size).toBe(0);
    await act(async () => button(container, "Refresh").click());
    expect(requests.at(-1)?.searchParams.has("after")).toBe(false);
  } finally {
    polling.restore();
  }
});

test("Debug only requests Claude inbound when its own flag is enabled", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/api/debug")) return Response.json(SETTINGS);
    return Response.json(url.includes("inbound-debug") ? { entries: [] } : []);
  }) as typeof fetch;
  const { container } = await mountDebug();
  await waitFor(
    () => container.textContent?.includes("Waiting for lines") ?? false,
  );
  expect(requests.some((url) => url.includes("inbound-debug"))).toBe(false);
  const logRequests = requests.filter((url) =>
    url.includes("/api/debug/logs"),
  ).length;
  const { setClientResourceData } = await import("../src/client-resource");
  await act(async () =>
    setClientResourceData("debug-settings:http://localhost", {
      ...SETTINGS,
      claude: true,
    }),
  );
  await waitFor(() => requests.some((url) => url.includes("inbound-debug")));
  expect(container.textContent).toContain("Claude inbound requests");
  expect(
    requests.filter((url) => url.includes("/api/debug/logs")),
  ).toHaveLength(logRequests);
  await act(async () =>
    setClientResourceData("debug-settings:http://localhost", SETTINGS),
  );
  expect(container.textContent).not.toContain("Claude inbound requests");
});

test.each([{ error: "unexpected response" }, [{ seq: 1 }]])(
  "Debug treats malformed log response %j as a fetch failure and can retry",
  async (invalid) => {
    let malformed = true;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/debug")) return Response.json(SETTINGS);
      return Response.json(malformed ? invalid : []);
    }) as typeof fetch;
    const { container } = await mountDebug();
    await waitFor(() => Boolean(container.querySelector('[role="alert"]')));
    expect(container.textContent).not.toContain("Waiting for lines");
    malformed = false;
    await act(async () => button(container, "Retry").click());
    await waitFor(
      () => container.textContent?.includes("Waiting for lines") ?? false,
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  },
);

test("Debug settings distinguish first loading, failure and retry without inventing disabled flags", async () => {
  const pending = deferred<Response>();
  let result = pending.promise;
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).endsWith("/api/debug")
      ? result
      : Response.json([])) as typeof fetch;
  const { container } = await mountDebug(null);
  expect(container.textContent).toContain("Loading debug settings");
  expect(container.textContent).not.toContain("Debug logging is off");
  await act(async () => pending.resolve(new Response(null, { status: 503 })));
  await waitFor(() => Boolean(container.querySelector('[role="alert"]')));
  expect(container.querySelector("button.switch")).toBeNull();
  result = Promise.resolve(Response.json(SETTINGS));
  await act(async () => button(container, "Retry").click());
  await waitFor(() => Boolean(container.querySelector("button.switch")));
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("Debug settings retain flags and independent log rows on refresh failure then recover", async () => {
  const polling = controlLogPolling(2000);
  let failed = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/debug"))
      return failed
        ? new Response(null, { status: 503 })
        : Response.json(SETTINGS);
    return Response.json([{ seq: 1, at: 0, line: "accepted log line" }]);
  }) as typeof fetch;
  try {
    const { container } = await mountDebug(null);
    await waitFor(
      () => container.textContent?.includes("accepted log line") ?? false,
    );
    failed = true;
    await polling.tick();
    expect(
      container
        .querySelector('button.switch[aria-label="Provider debug"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.textContent).toContain("accepted log line");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    failed = false;
    await act(async () => button(container, "Retry").click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("accepted log line");
  } finally {
    polling.restore();
  }
});

test("Claude inbound distinguishes first loading, failure and successful empty retry", async () => {
  const pending = deferred<Response>();
  let result = pending.promise;
  const settings = { ...SETTINGS, claude: true };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/debug")) return Response.json(settings);
    return url.includes("inbound-debug") ? result : Response.json([]);
  }) as typeof fetch;
  const { container } = await mountDebug(settings);
  expect(container.textContent).toContain("Claude inbound requests");
  expect(container.textContent).not.toContain("No requests captured yet");
  await act(async () => pending.resolve(new Response(null, { status: 503 })));
  await waitFor(() => Boolean(container.querySelector('[role="alert"]')));
  expect(container.textContent).not.toContain("No requests captured yet");
  result = Promise.resolve(Response.json({ entries: [] }));
  await act(async () => button(container, "Retry").click());
  await waitFor(
    () => container.textContent?.includes("No requests captured yet") ?? false,
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("Claude inbound retains its accepted rows after a failed refresh without disturbing settings", async () => {
  const polling = controlLogPolling(2000);
  const settings = { ...SETTINGS, claude: true };
  let result: "first" | "failed" | "recovered" = "first";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/debug")) return Response.json(settings);
    if (!url.includes("inbound-debug")) return Response.json([]);
    if (result === "failed") return new Response(null, { status: 503 });
    return Response.json({
      entries: [
        {
          id: 1,
          at: 0,
          endpoint: "/v1/messages",
          model: result === "first" ? "claude-first" : "claude-recovered",
          hasMetadataUserId: false,
          hasSystem: false,
        },
      ],
    });
  }) as typeof fetch;
  try {
    const { container } = await mountDebug(settings);
    await waitFor(
      () => container.textContent?.includes("claude-first") ?? false,
    );
    result = "failed";
    await polling.tick();
    expect(container.textContent).toContain("claude-first");
    expect(container.textContent).not.toContain("No requests captured yet");
    expect(
      container
        .querySelector('button.switch[aria-label="Claude inbound"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    result = "recovered";
    await act(async () => button(container, "Retry").click());
    await waitFor(
      () => container.textContent?.includes("claude-recovered") ?? false,
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    polling.restore();
  }
});
