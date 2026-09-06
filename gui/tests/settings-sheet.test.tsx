import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createRef, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { seedDicts } from "./helpers/locales";

await seedDicts();

const GLOBALS = [
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
let descriptors: Map<string, PropertyDescriptor | undefined>;
let testWindow: Window;
let root: Root | undefined;
let host: HTMLDivElement;
let opener: HTMLButtonElement;
let SettingsSheet: typeof import("../src/components/SettingsSheet").default;
type Theme = "light" | "dark" | "system";

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
  for (const key of GLOBALS) {
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
  host = document.createElement("div");
  opener = document.createElement("button");
  opener.textContent = "Open settings";
  document.body.append(opener, host);
  // Base UI's browser capability detection must see the real DOM environment.
  // Use the canonical --isolate suite: unrelated SSR/static imports can otherwise
  // cache its no-op useIsoLayoutEffect before this file's setup. Never reset/mock it.
  SettingsSheet = (await import("../src/components/SettingsSheet")).default;
});

afterEach(async () => {
  if (root)
    await act(async () => {
      root!.unmount();
    });
  host.remove();
  opener.remove();
  await testWindow.happyDOM.close();
  for (const key of GLOBALS) {
    const descriptor = descriptors.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount(initialOpen = true) {
  const themes: Theme[] = [];
  let closes = 0;
  const returnFocusRef = createRef<HTMLButtonElement>();
  returnFocusRef.current = opener;
  function Harness() {
    const [open, setOpen] = useState(initialOpen);
    const [theme, setTheme] = useState<Theme>("system");
    return (
      <SettingsSheet
        open={open}
        instant
        returnFocusRef={returnFocusRef}
        theme={theme}
        onTheme={(next) => {
          themes.push(next);
          setTheme(next);
        }}
        onClose={() => {
          closes++;
          setOpen(false);
        }}
      />
    );
  }
  opener.focus();
  root = (await import("react-dom/client")).createRoot(host);
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <Harness />
      </LanguageProvider>,
    );
  });
  return { themes, closes: () => closes };
}

function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

async function until(predicate: () => boolean) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 1000)
      throw new Error("SettingsSheet condition did not settle within 1s");
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 10));
    });
  }
}

describe("SettingsSheet real Base UI behavior", () => {
  for (const [locale, title, closeLabel] of [
    ["en", "Settings", "Close"],
    ["nl", "Instellingen", "Sluit"],
  ]) {
    test(`exposes a labelled dialog and translated close control in ${locale}`, async () => {
      testWindow.localStorage.setItem("ocx-lang", locale);
      await mount();
      await until(() => dialog() !== null);
      const popup = dialog()!;
      const titleId = popup.getAttribute("aria-labelledby");
      expect(titleId).toBeTruthy();
      expect(document.getElementById(titleId!)?.textContent).toBe(title);
      expect(popup.contains(document.getElementById(titleId!))).toBe(true);
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(
        popup.querySelector(`button[aria-label="${closeLabel}"]`),
      ).not.toBeNull();
      expect(popup.getAttribute("data-instant")).toBe("true");
    });
  }

  test("closed sheet creates no accessible dialog or close callback", async () => {
    const events = await mount(false);
    expect(dialog()).toBeNull();
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
    expect(events.closes()).toBe(0);
    expect(events.themes).toEqual([]);
  });

  test("all theme controls preserve callback values and selected semantics", async () => {
    const events = await mount();
    await until(() => dialog() !== null);
    const group = dialog()!.querySelector(
      '[role="group"][aria-label="Theme"]',
    )!;
    const controls = [...group.querySelectorAll<HTMLButtonElement>("button")];
    expect(controls.map((button) => button.textContent?.trim())).toEqual([
      "Light",
      "Dark",
      "System",
    ]);
    expect(
      controls.map((button) => button.getAttribute("aria-pressed")),
    ).toEqual(["false", "false", "true"]);
    for (const [index, button] of controls.entries()) {
      await act(async () => {
        button.click();
      });
      expect(events.themes).toEqual(
        (["light", "dark", "system"] as Theme[]).slice(0, index + 1),
      );
      expect(
        controls.map((control) => control.getAttribute("aria-pressed")),
      ).toEqual(controls.map((_, current) => String(current === index)));
    }
    expect(events.closes()).toBe(0);
  });

  test("close invokes callback once, removes the dialog and restores returnFocusRef", async () => {
    const events = await mount();
    await until(() => dialog() !== null);
    const close = dialog()!.querySelector<HTMLButtonElement>(
      'button[aria-label="Close"]',
    )!;
    await until(() => document.activeElement === close);
    await act(async () => {
      close.click();
    });
    await until(() => dialog() === null);
    await until(() => document.activeElement === opener);
    expect(events.closes()).toBe(1);
    expect(document.activeElement).toBe(opener);
    expect(events.themes).toEqual([]);
  });

  for (const openWith of ["keyboard", "pointer"] as const) {
    test(`${openWith}-opened language list consumes first Escape; second closes sheet and restores focus`, async () => {
      const events = await mount();
      await until(() => dialog() !== null);
      const popup = dialog()!;
      const close = popup.querySelector<HTMLButtonElement>(
        'button[aria-label="Close"]',
      )!;
      await until(() => document.activeElement === close);
      const combo = popup.querySelector<HTMLButtonElement>(
        '[role="combobox"][aria-label="Language"]',
      )!;
      combo.focus();
      await act(async () => {
        if (openWith === "pointer") combo.click();
        else
          combo.dispatchEvent(
            new testWindow.KeyboardEvent("keydown", {
              key: "ArrowDown",
              bubbles: true,
              cancelable: true,
            }) as unknown as KeyboardEvent,
          );
      });
      expect(combo.getAttribute("aria-expanded")).toBe("true");
      expect(popup.querySelector('[role="listbox"]')).not.toBeNull();
      expect(document.activeElement).toBe(combo);

      const escape = () =>
        combo.dispatchEvent(
          new testWindow.KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
            cancelable: true,
          }) as unknown as KeyboardEvent,
        );
      await act(async () => {
        escape();
      });
      expect(document.querySelector('[role="listbox"]')).toBeNull();
      expect(combo.getAttribute("aria-expanded")).toBe("false");
      expect(dialog()).toBe(popup);
      expect(document.activeElement).toBe(combo);
      expect(events.closes()).toBe(0);
      expect(events.themes).toEqual([]);

      await act(async () => {
        escape();
      });
      await until(() => dialog() === null);
      await until(() => document.activeElement === opener);
      expect(events.closes()).toBe(1);
      expect(document.activeElement).toBe(opener);
    });
  }

  test("language selection updates controlled labels and persists locale without closing the sheet", async () => {
    const events = await mount();
    await until(() => dialog() !== null);
    for (const [option, locale, title, label] of [
      ["Nederlands", "nl", "Instellingen", "Taal"],
      ["English", "en", "Settings", "Language"],
    ]) {
      const combo =
        dialog()!.querySelector<HTMLButtonElement>('[role="combobox"]')!;
      combo.focus();
      await act(async () => {
        combo.click();
      });
      const target = [
        ...dialog()!.querySelectorAll<HTMLButtonElement>('[role="option"]'),
      ].find((button) => button.textContent === option);
      expect(target).toBeDefined();
      await act(async () => {
        target!.click();
      });
      const popup = dialog()!;
      expect(
        document.getElementById(popup.getAttribute("aria-labelledby")!)
          ?.textContent,
      ).toBe(title);
      expect(combo.getAttribute("aria-label")).toBe(label);
      expect(combo.textContent).toBe(option);
      expect(combo.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector('[role="listbox"]')).toBeNull();
      expect(document.activeElement).toBe(combo);
      expect(testWindow.localStorage.getItem("ocx-lang")).toBe(locale);
      expect(events.closes()).toBe(0);
      expect(events.themes).toEqual([]);
    }
  });
});
