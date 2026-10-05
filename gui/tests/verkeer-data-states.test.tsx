import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
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
let Verkeer: typeof import("../src/pages/Verkeer").default;
let usageReply: () => Promise<Response>;
let cacheReply: () => Promise<Response>;
let usagePoll: (() => void) | undefined;
let cachePoll: (() => void) | undefined;

function reading(label: string): string | undefined {
  return [...host.querySelectorAll<HTMLElement>(".stat-strip-item")].find(
    (item) => item.querySelector(".stat-strip-label")?.textContent === label,
  )?.querySelector(".stat-strip-waarde")?.textContent;
}

beforeEach(async () => {
  descriptors = new Map(
    GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
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
      ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key)
    )
      value = value.bind(testWindow);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  testWindow.localStorage.setItem("ocx-lang", "en");
  host = document.createElement("div");
  document.body.append(host);
  usageReply = async () => new Response("Unavailable", { status: 503 });
  cacheReply = async () => new Response("Unavailable", { status: 503 });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/usage?range=30d")) return usageReply();
    if (url.endsWith("/api/response-cache")) return cacheReply();
    if (url.endsWith("/api/logs")) return Response.json([]);
    throw new Error(`Unexpected Verkeer request: ${url}`);
  }) as typeof fetch;
  globalThis.setInterval = ((callback: () => void, delay?: number) => {
    if (delay === 60_000) usagePoll = callback;
    if (delay === 15_000) cachePoll = callback;
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  Verkeer = (await import("../src/pages/Verkeer")).default;
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

test("Verkeer keeps usage and proxy-cache readings unknown on first-load failure, then recovers independently", async () => {
  root = (await import("react-dom/client")).createRoot(host);
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <Verkeer apiBase="http://localhost/verkeer-state" />
      </LanguageProvider>,
    );
  });

  expect(host.textContent).toContain("Could not load usage data.");
  expect(host.textContent).toContain("Could not load cache statistics.");
  expect(reading("tokens (30d)")).toBe("—");
  expect(reading("requests (30d)")).toBe("—");
  expect(reading("proxy-cache")).toBe("—");

  usageReply = async () =>
    Response.json({
      summary: { requests: 17, totalTokens: 321 },
      days: [],
      providers: [],
      models: [],
    });
  cacheReply = async () =>
    Response.json({ enabled: true, stats: { hits: 3, misses: 1 } });
  const retries = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.textContent === "Retry",
  );
  expect(retries).toHaveLength(2);
  await act(async () => {
    retries[0]!.click();
  });
  expect(host.textContent).not.toContain("Could not load usage data.");
  expect(reading("tokens (30d)")).toBe("321");
  expect(reading("requests (30d)")).toBe("17");
  expect(host.textContent).toContain("Could not load cache statistics.");

  await act(async () => {
    retries[1]!.click();
  });
  expect(host.textContent).not.toContain("Could not load cache statistics.");
  expect(reading("proxy-cache")).toBe("75%");

  usageReply = async () => new Response("Unavailable", { status: 503 });
  cacheReply = async () => new Response("Unavailable", { status: 503 });
  expect(usagePoll).toBeDefined();
  expect(cachePoll).toBeDefined();
  await act(async () => {
    usagePoll!();
    cachePoll!();
  });
  expect(host.textContent).toContain("Could not load usage data.");
  expect(host.textContent).toContain("Could not load cache statistics.");
  expect(reading("tokens (30d)")).toBe("321");
  expect(reading("requests (30d)")).toBe("17");
  expect(reading("proxy-cache")).toBe("75%");
});
