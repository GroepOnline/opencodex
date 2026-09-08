import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ComponentProps } from "react";
import type { Root } from "react-dom/client";

const globals = [
  "document",
  "window",
  "navigator",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
let previous: Map<string, PropertyDescriptor | undefined>;
let testWindow: Window;
let host: HTMLDivElement;
let root: Root | undefined;
let FieldError: typeof import("../src/components/primitives/field").FieldError;

beforeEach(async () => {
  previous = new Map(
    globals.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  testWindow = new Window({ url: "http://localhost/" });
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === "window"
          ? testWindow
          : key === "IS_REACT_ACT_ENVIRONMENT"
            ? true
            : Reflect.get(testWindow, key),
    });
  }
  host = document.createElement("div");
  document.body.append(host);
  // Import DOM-aware components after installing the test environment, keeping
  // the package runner's module isolation instead of mocking React internals.
  ({ FieldError } = await import("../src/components/primitives/field"));
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);
});

afterEach(async () => {
  try {
    if (root)
      await act(async () => {
        root!.unmount();
      });
    root = undefined;
    host.remove();
    await testWindow.happyDOM.close();
  } finally {
    for (const key of globals) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

async function render(props: ComponentProps<typeof FieldError>) {
  await act(async () => {
    root!.render(<FieldError {...props} />);
  });
}

test("FieldError preserves each error message's DOM node when errors reorder", async () => {
  await render({
    errors: [
      { message: "Model is required" },
      { message: "Provider is required" },
    ],
  });
  const initial = [...host.querySelectorAll("li")];
  expect(initial.map((node) => node.textContent)).toEqual([
    "Model is required",
    "Provider is required",
  ]);

  await render({
    errors: [
      { message: "Provider is required" },
      { message: "Model is required" },
    ],
  });
  const reordered = [...host.querySelectorAll("li")];
  expect(reordered.map((node) => node.textContent)).toEqual([
    "Provider is required",
    "Model is required",
  ]);
  // Text-only assertions also pass with index keys: test the actual identity
  // that React reconciles so each message keeps its own existing DOM node.
  expect(reordered[0] === initial[1]).toBe(true);
  expect(reordered[1] === initial[0]).toBe(true);
});

test("FieldError deduplicates repeated messages and renders one accessible alert", async () => {
  await render({
    errors: [
      { message: "Model is required" },
      { message: "Provider is required" },
      { message: "Model is required" },
    ],
  });
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(
    [...host.querySelectorAll("li")].map((node) => node.textContent),
  ).toEqual(["Model is required", "Provider is required"]);

  await render({
    errors: [
      { message: "Model is required" },
      { message: "Model is required" },
    ],
  });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Model is required",
  );
  expect(host.querySelector("ul")).toBeNull();
});

test("FieldError removes the alert when errors clear and honors explicit children", async () => {
  await render({ errors: [{ message: "Model is required" }] });
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  for (const errors of [[], undefined, [undefined], [{}]]) {
    await render({ errors });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.childNodes).toHaveLength(0);
  }

  await render({
    errors: [{ message: "Model is required" }],
    children: "Custom validation guidance",
  });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Custom validation guidance",
  );
});
