import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { localCalendarDayKey } from "../src/traffic-shared";
import { seedDicts } from "./helpers/locales";

await seedDicts();

const DOM_GLOBALS = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "HTMLElement",
  "Element",
  "SVGElement",
  "Node",
  "Document",
  "ShadowRoot",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const GLOBALS = [...DOM_GLOBALS, "fetch", "setInterval"] as const;
let descriptors: Map<string, PropertyDescriptor | undefined>;
let testWindow: Window;
let root: Root | undefined;
let host: HTMLDivElement;
let poll: (() => void) | undefined;
let usageReply: () => Promise<Response>;
let logsReply: () => Promise<Response>;
let Dashboard: typeof import("../src/pages/Dashboard").default;
let sequence = 0;
const labels = ["tokens (30d)", "requests (30d)", "requests today"];

function usage(requests = 0, totalTokens = 0, today = 0) {
  return {
    summary: { requests, totalTokens, p95LatencyMs: 0, p95TtftMs: 0 },
    days: today ? [{ date: localCalendarDayKey(), requests: today }] : [],
    providers: [],
  };
}

beforeEach(async () => {
  descriptors = new Map(
    GLOBALS.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
  for (const key of DOM_GLOBALS) {
    let value =
      key === "window"
        ? testWindow
        : key === "IS_REACT_ACT_ENVIRONMENT"
          ? true
          : Reflect.get(testWindow, key);
    if (
      [
        "getComputedStyle",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ].includes(key)
    )
      value = value.bind(testWindow);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  testWindow.localStorage.setItem("ocx-lang", "en");
  root = undefined;
  poll = undefined;
  host = document.createElement("div");
  document.body.append(host);
  usageReply = async () => Response.json(usage());
  logsReply = async () => Response.json([]);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/healthz"))
      return Response.json({
        status: "ok",
        service: "opencodex",
        version: "test",
        uptime: 1,
        pid: 1,
        port: 1,
      });
    if (url.endsWith("/api/usage?range=30d")) return usageReply();
    if (url.endsWith("/api/logs")) return logsReply();
    throw new Error(`Unexpected dashboard request: ${url}`);
  }) as typeof fetch;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((callback: () => void, delay?: number) => {
    // Exercise the real polling callback without waiting thirty seconds or
    // replacing timers globally with an accelerated fake clock.
    if (delay === 30_000) poll = callback;
    return originalSetInterval(callback, delay);
  }) as typeof setInterval;
  // Dashboard now renders real Base UI buttons. Its dependency graph must load
  // after browser setup, inside the canonical bun test --isolate file boundary.
  Dashboard = (await import("../src/pages/Dashboard")).default;
});

afterEach(async () => {
  if (root)
    await act(async () => {
      root!.unmount();
    });
  host.remove();
  await testWindow.happyDOM.close();
  for (const key of GLOBALS) {
    const descriptor = descriptors.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount() {
  root = (await import("react-dom/client")).createRoot(host);
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <Dashboard apiBase={`http://localhost/dashboard-state-${++sequence}`} />
      </LanguageProvider>,
    );
  });
}

function values() {
  return labels.map((label) => {
    const element = [...host.querySelectorAll("dt")].find(
      (node) => node.textContent === label,
    );
    expect(element).toBeDefined();
    return element!.parentElement!.querySelector("dd")!.textContent;
  });
}

function assertFailureNotices() {
  expect(host.textContent).toContain("Could not load usage data.");
  expect(host.textContent).toContain(
    "Could not load traffic. Last known rows stay visible.",
  );
}

describe("Dashboard observed data states", () => {
  test("first load shows unknown values until usage and traffic resolve, not fake zeroes", async () => {
    let resolveUsage!: (response: Response) => void;
    let resolveLogs!: (response: Response) => void;
    const pendingUsage = new Promise<Response>((resolve) => {
      resolveUsage = resolve;
    });
    const pendingLogs = new Promise<Response>((resolve) => {
      resolveLogs = resolve;
    });
    usageReply = () => pendingUsage;
    logsReply = () => pendingLogs;
    await mount();
    try {
      expect(values()).toEqual(["—", "—", "—"]);
      expect(host.textContent).not.toContain("Could not load usage data.");
    } finally {
      await act(async () => {
        resolveUsage(Response.json(usage()));
        resolveLogs(Response.json([]));
      });
    }
    expect(values()).toEqual(["0", "0", "0"]);
  });

  for (const failure of ["http", "network"] as const) {
    const fail = async (): Promise<Response> => {
      if (failure === "network") throw new TypeError("Failed to fetch");
      return new Response("Unavailable", { status: 503 });
    };

    test(`${failure} failure before first successful data keeps every metric unknown`, async () => {
      usageReply = fail;
      logsReply = fail;
      await mount();
      assertFailureNotices();
      expect(values()).toEqual(["—", "—", "—"]);
    });

    test(`${failure} refresh failure preserves last-known successful metrics`, async () => {
      usageReply = async () => Response.json(usage(17, 321));
      logsReply = async () =>
        Response.json([
          {
            requestId: "known-request",
            timestamp: Date.now(),
            model: "known-model",
            provider: "fixture",
            status: 200,
            durationMs: 100,
            totalTokens: 321,
          },
        ]);
      await mount();
      expect(values()).toEqual(["321", "17", "1"]);
      expect(host.textContent).toContain("known-model");
      usageReply = fail;
      logsReply = fail;
      expect(poll).toBeDefined();
      await act(async () => {
        poll!();
      });
      assertFailureNotices();
      expect(values()).toEqual(["321", "17", "1"]);
      expect(host.textContent).toContain("known-model");
    });
  }

  test("successful empty logs and zero usage show actual zeroes without failure notices", async () => {
    await mount();
    expect(values()).toEqual(["0", "0", "0"]);
    expect(host.textContent).not.toContain("Could not load usage data.");
    expect(host.textContent).not.toContain("Could not load traffic.");
  });
});
