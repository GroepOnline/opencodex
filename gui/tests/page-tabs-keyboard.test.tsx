import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState, type KeyboardEventHandler } from "react";
import type { Root } from "react-dom/client";
import { PageTab, PageTabPanel, PageTabs } from "../src/components/primitives/page-tabs";

const globals = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: PropertyDescriptor[];
let testWindow: Window;
let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  previous = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key) ?? {});
  testWindow = new Window({ url: "http://localhost/" });
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(testWindow, key),
    });
  }
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = undefined;
  await testWindow.happyDOM.close();
  globals.forEach((key, i) => {
    if (Object.keys(previous[i]).length) Object.defineProperty(globalThis, key, previous[i]);
    else Reflect.deleteProperty(globalThis, key);
  });
});

function Tabs({ onKeyDown }: { onKeyDown?: KeyboardEventHandler<HTMLButtonElement> }) {
  const [selected, setSelected] = useState("one");
  return (
    <>
      <PageTabs label="Workspace">
        {["one", "two", "three"].map(id => (
          <PageTab key={id} id={id} controls={`${id}-panel`} selected={selected === id}
            onClick={() => setSelected(id)} onKeyDown={onKeyDown}>{id}</PageTab>
        ))}
      </PageTabs>
      <PageTabPanel id={`${selected}-panel`} labelledBy={selected}>{selected}</PageTabPanel>
    </>
  );
}

async function mount(onKeyDown?: KeyboardEventHandler<HTMLButtonElement>) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<Tabs onKeyDown={onKeyDown} />);
  });
  container.querySelector<HTMLButtonElement>("#one")?.focus();
}

async function press(key: string, options: { ctrlKey?: boolean } = {}) {
  const event = new testWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  await act(async () => { document.activeElement?.dispatchEvent(event); });
  return event.defaultPrevented;
}

function expectSelected(id: string) {
  expect(document.activeElement?.id).toBe(id);
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe(id);
  expect(container.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
  expect(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(id);
}

test("tabs without page-specific handlers remain reachable with arrows, Home and End", async () => {
  await mount();
  expect(await press("ArrowRight")).toBe(true);
  expectSelected("two");
  await press("End");
  expectSelected("three");
  await press("ArrowRight");
  expectSelected("one");
  await press("ArrowLeft");
  expectSelected("three");
  await press("Home");
  expectSelected("one");
});

test("default navigation leaves browser shortcuts and Tab alone", async () => {
  await mount();
  expect(await press("ArrowRight", { ctrlKey: true })).toBe(false);
  expect(await press("Tab")).toBe(false);
  expectSelected("one");
});

test("page-owned keyboard guards are not bypassed or invoked twice", async () => {
  let calls = 0;
  await mount(event => { calls += 1; event.preventDefault(); });
  expect(await press("ArrowRight")).toBe(true);
  expect(calls).toBe(1);
  expectSelected("one");
});
