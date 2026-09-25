import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import SkipLink from "../src/components/SkipLink";

const globals = [
  "window",
  "document",
  "navigator",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const previous = new Map<string, PropertyDescriptor | undefined>();
let win: Window;
let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  win = new Window({ url: "http://localhost/#modellen/combos" });
  for (const key of globals) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === "IS_REACT_ACT_ENVIRONMENT"
          ? true
          : key === "window"
            ? win
            : Reflect.get(win, key),
    });
  }
  host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  win.close();
  for (const key of globals) {
    const descriptor = previous.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

for (const detail of [0, 1]) {
  test(`skip-link focuses content without changing route or history (click detail ${detail})`, async () => {
    await act(async () => {
      root.render(
        <>
          <SkipLink targetId="main-content">Naar inhoud</SkipLink>
          <main id="main-content" tabIndex={-1}>
            Inhoud
          </main>
        </>,
      );
    });
    const link = host.querySelector("a")!;
    const main = host.querySelector("main")!;
    const scrolls: ScrollIntoViewOptions[] = [];
    main.scrollIntoView = (options) => {
      scrolls.push(options as ScrollIntoViewOptions);
    };
    link.focus();
    const historyLength = win.history.length;
    const click = new win.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail,
    });
    await act(async () => {
      link.dispatchEvent(click as unknown as MouseEvent);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(main);
    expect(win.location.hash).toBe("#modellen/combos");
    expect(win.history.length).toBe(historyLength);
    expect(scrolls).toEqual([{ block: "start", behavior: "instant" }]);
  });
}
