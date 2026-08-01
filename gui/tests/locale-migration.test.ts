import { afterEach, beforeEach, expect, test } from "bun:test";
import { detectInitial } from "../src/i18n/shared";

/**
 * This build ships `en` and `nl` only. Browsers that stored `de`, `ja`, `ko`, `ru`, or `zh`
 * before those locales were retired must not silently land on the Dutch default: the saved
 * value was an explicit "not Dutch" choice, so it migrates to English and is written back.
 */

const globals = ["localStorage", "navigator"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let store: Map<string, string>;

function install(language: string): void {
  const localStorageStub = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  Object.defineProperties(globalThis, {
    localStorage: { configurable: true, value: localStorageStub },
    navigator: { configurable: true, value: { language } },
  });
}

beforeEach(() => {
  previous = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previous;
  store = new Map();
});

afterEach(() => {
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("saved preferences for retired locales migrate to English and persist", () => {
  for (const retired of ["de", "ja", "ko", "ru", "zh"]) {
    store = new Map([["ocx-lang", retired]]);
    // A Dutch browser is the hostile case: without the migration the Dutch default wins.
    install("nl-NL");
    expect(detectInitial()).toBe("en");
    expect(store.get("ocx-lang")).toBe("en");
  }
});

test("shipped preferences are returned untouched", () => {
  for (const shipped of ["en", "nl"] as const) {
    store = new Map([["ocx-lang", shipped]]);
    install(shipped === "en" ? "nl-NL" : "en-US");
    expect(detectInitial()).toBe(shipped);
    expect(store.get("ocx-lang")).toBe(shipped);
  }
});

test("an unknown saved value falls through to browser detection without persisting", () => {
  store = new Map([["ocx-lang", "klingon"]]);
  install("en-US");
  expect(detectInitial()).toBe("en");
  expect(store.get("ocx-lang")).toBe("klingon");

  store = new Map([["ocx-lang", "klingon"]]);
  install("fr-FR");
  expect(detectInitial()).toBe("nl");
});

test("with no saved preference the Dutch host default still applies", () => {
  install("de-DE");
  expect(detectInitial()).toBe("nl");
  expect(store.has("ocx-lang")).toBe(false);

  install("en-GB");
  expect(detectInitial()).toBe("en");
});
