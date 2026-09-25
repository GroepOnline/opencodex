import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { seedDicts } from "./helpers/locales";

await seedDicts();
const globals = [
  "window",
  "document",
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
  "fetch",
  "setInterval",
] as const;
let previous: Map<string, PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLDivElement;
let root: Root;
let Verkeer: typeof import("../src/pages/Verkeer").default;
let usageReply: () => Promise<Response>;
let cacheReply: () => Promise<Response>;
let polls: Map<number, () => void>;

beforeEach(async () => {
  clearClientResourceStoresForTests();
  previous = new Map(
    globals.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  win = new Window({ url: "http://localhost/" });
  win.localStorage.setItem("ocx-lang", "en");
  for (const key of globals.filter(
    (key) => key !== "fetch" && key !== "setInterval",
  )) {
    let value =
      key === "window"
        ? win
        : key === "IS_REACT_ACT_ENVIRONMENT"
          ? true
          : Reflect.get(win, key);
    if (
      [
        "getComputedStyle",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ].includes(key)
    )
      value = value.bind(win);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  polls = new Map();
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    polls.set(delay, callback);
    return 0;
  }) as typeof setInterval;
  usageReply = async () => new Response(null, { status: 503 });
  cacheReply = async () => new Response(null, { status: 503 });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/api/usage")) return usageReply();
    if (url.endsWith("/api/response-cache")) return cacheReply();
    if (url.endsWith("/api/logs")) return Response.json([]);
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.append(host);
  Verkeer = (await import("../src/pages/Verkeer")).default;
  root = (await import("react-dom/client")).createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  clearClientResourceStoresForTests();
  await win.happyDOM.close();
  for (const key of globals) {
    const descriptor = previous.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function reading(label: string) {
  return [...host.querySelectorAll(".stat-strip-item")]
    .find(
      (item) => item.querySelector(".stat-strip-label")?.textContent === label,
    )
    ?.querySelector(".stat-strip-waarde")?.textContent;
}
async function render(apiBase = "http://localhost/traffic") {
  await act(async () =>
    root.render(
      <LanguageProvider>
        <Verkeer apiBase={apiBase} />
      </LanguageProvider>,
    ),
  );
}

test("traffic resources show unknown failures, recover independently and retain only same-API readings", async () => {
  await render();
  expect(reading("tokens (30d)")).toBe("—");
  expect(reading("requests (30d)")).toBe("—");
  expect(host.textContent).toContain("Could not load usage data.");
  expect(host.textContent).toContain("Could not load cache statistics.");
  usageReply = async () =>
    Response.json({
      summary: { requests: 17, totalTokens: 321 },
      days: [],
      models: [],
      providers: [],
    });
  cacheReply = async () =>
    Response.json({ enabled: true, stats: { hits: 3, misses: 1 } });
  const retries = [...host.querySelectorAll("button")].filter(
    (button) => button.textContent === "Retry",
  );
  expect(retries).toHaveLength(2);
  await act(async () => retries[0]!.click());
  expect(reading("tokens (30d)")).toBe("321");
  expect(host.textContent).toContain("Could not load cache statistics.");
  await act(async () => retries[1]!.click());
  expect(reading("proxy-cache")).toBe("75%");
  usageReply = cacheReply = async () => new Response(null, { status: 503 });
  await act(async () => {
    polls.get(60_000)!();
    polls.get(15_000)!();
  });
  expect(reading("tokens (30d)")).toBe("321");
  expect(reading("proxy-cache")).toBe("75%");
  expect(host.textContent).toContain("Could not load usage data.");
  await render("http://localhost/other-traffic");
  expect(reading("tokens (30d)")).toBe("—");
  expect(reading("proxy-cache")).toBe("—");
});
