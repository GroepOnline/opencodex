import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { RemoveConfirmDialog } from "../src/components/provider-workspace/ProviderDialogs";
import { seedDicts } from "./helpers/locales";

await seedDicts();

const globals = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
let previous: PropertyDescriptor[];
let testWindow: Window;
let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  previous = globals.map(
    (key) => Object.getOwnPropertyDescriptor(globalThis, key) ?? {},
  );
  testWindow = new Window({ url: "http://localhost/" });
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value:
        key === "IS_REACT_ACT_ENVIRONMENT"
          ? true
          : key === "window"
            ? testWindow
            : Reflect.get(testWindow, key),
    });
  }
  testWindow.localStorage.setItem("ocx-lang", "en");
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root)
    await act(async () => {
      root?.unmount();
    });
  root = undefined;
  await testWindow.happyDOM.close();
  globals.forEach((key, i) => {
    if (Object.keys(previous[i]).length)
      Object.defineProperty(globalThis, key, previous[i]);
    else Reflect.deleteProperty(globalThis, key);
  });
});

function RemoveFlow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" id="remove-trigger" onClick={() => setOpen(true)}>
        Remove provider
      </button>
      <button type="button" id="background-control">
        Background
      </button>
      {open ? (
        <RemoveConfirmDialog
          providerName="fixture"
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

async function mount() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <RemoveFlow />
      </LanguageProvider>,
    );
  });
}

async function pressTab(shiftKey = false) {
  const event = new testWindow.KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
    shiftKey,
  });
  await act(async () => {
    document.dispatchEvent(event);
  });
  return event;
}

test("remove-confirmation dialog traps Tab and restores focus to the trigger", async () => {
  await mount();
  const trigger = container.querySelector<HTMLButtonElement>("#remove-trigger");
  const background = container.querySelector<HTMLButtonElement>(
    "#background-control",
  );
  expect(trigger).toBeDefined();
  expect(background).toBeDefined();
  trigger!.focus();
  expect(document.activeElement).toBe(trigger);

  await act(async () => {
    trigger!.click();
  });

  const dialog = container.querySelector<HTMLElement>('[role="alertdialog"]');
  expect(dialog).toBeDefined();
  expect(dialog!.getAttribute("aria-modal")).toBe("true");

  const buttons = [...dialog!.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons).toHaveLength(2);
  expect(document.activeElement).toBe(buttons[0]);
  expect(dialog!.contains(document.activeElement)).toBe(true);

  const firstTab = await pressTab();
  expect(firstTab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(buttons[1]);
  expect(document.activeElement).not.toBe(background);

  const wrapTab = await pressTab();
  expect(wrapTab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(buttons[0]);

  const shiftTab = await pressTab(true);
  expect(shiftTab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(buttons[1]);
  expect(background!.contains(document.activeElement)).toBe(false);
  expect(document.activeElement).not.toBe(background);

  await act(async () => {
    buttons[0].click();
  });
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
