import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { RemoveConfirmDialog } from "../src/components/provider-workspace/ProviderDialogs";
import { seedDicts } from "./helpers/locales";

await seedDicts();

const GLOBALS = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "HTMLElement",
  "Element",
  "Node",
  "Document",
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
let trigger: HTMLButtonElement;

beforeEach(() => {
  descriptors = new Map(
    GLOBALS.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  testWindow = new Window({ url: "http://localhost/" });
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
  host = document.createElement("div");
  trigger = document.createElement("button");
  trigger.textContent = "Remove";
  document.body.append(trigger, host);
  trigger.focus();
});

afterEach(async () => {
  if (root)
    await act(async () => {
      root!.unmount();
    });
  host.remove();
  trigger.remove();
  await testWindow.happyDOM.close();
  for (const key of GLOBALS) {
    const descriptor = descriptors.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("remove confirmation traps initial focus, handles Escape, and restores the trigger", async () => {
  let cancelled = 0;
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <RemoveConfirmDialog
          providerName="demo"
          onConfirm={() => {}}
          onCancel={() => {
            cancelled += 1;
          }}
        />
      </LanguageProvider>,
    );
  });

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.getAttribute("aria-modal")).toBe("true");

  const cancel = document.querySelector<HTMLButtonElement>(".btn-ghost");
  expect(cancel).not.toBeNull();
  expect(document.activeElement).toBe(cancel);

  await act(async () => {
    dialog?.dispatchEvent(
      new testWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(cancelled).toBe(1);

  await act(async () => {
    root!.unmount();
    root = undefined;
  });
  expect(document.activeElement).toBe(trigger);
});
