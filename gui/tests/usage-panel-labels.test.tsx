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
const GLOBALS = [...DOM_GLOBALS, "fetch"] as const;
let descriptors: Map<string, PropertyDescriptor | undefined>;
let testWindow: Window;
let root: Root | undefined;
let host: HTMLDivElement;
let Usage: typeof import("../src/pages/Usage").default;

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
  host = document.createElement("div");
  document.body.append(host);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/usage")) {
      return Response.json({
        range: "30d",
        surface: "all",
        since: Date.now() - 86_400_000,
        generatedAt: Date.now(),
        summary: {
          requests: 4,
          measuredRequests: 4,
          reportedRequests: 4,
          unreportedRequests: 0,
          unsupportedRequests: 0,
          estimatedRequests: 0,
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 15,
          coverageRatio: 1,
        },
        days: [],
        models: [],
        providers: [],
      });
    }
    throw new Error(`Unexpected usage request: ${url}`);
  }) as typeof fetch;
  Usage = (await import("../src/pages/Usage")).default;
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

test("every rendered Usage panel has a unique aria-labelledby heading", async () => {
  root = (await import("react-dom/client")).createRoot(host);
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <Usage apiBase="http://localhost/usage-panels" />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  });

  const deadline = Date.now() + 1000;
  while (
    host.querySelectorAll("section.panel").length < 6 &&
    Date.now() < deadline
  ) {
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 10));
    });
  }

  const panels = [...host.querySelectorAll<HTMLElement>("section.panel")];
  expect(panels.length).toBeGreaterThanOrEqual(6);
  const labelledBy = panels.map((panel) =>
    panel.getAttribute("aria-labelledby"),
  );
  expect(new Set(labelledBy).size).toBe(labelledBy.length);
  for (const panel of panels) {
    const id = panel.getAttribute("aria-labelledby");
    expect(id).toBeTruthy();
    const heading = host.querySelector(`#${id}`);
    expect(heading).toBeDefined();
    expect(heading!.tagName).toBe("H3");
    expect(panel.contains(heading)).toBe(true);
    expect((heading!.textContent ?? "").trim().length).toBeGreaterThan(0);
  }
});
