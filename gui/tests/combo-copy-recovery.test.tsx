import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { DetailPanel } from "../src/components/combo-workspace-detail-panel";
import type { ComboItem } from "../src/combo-workspace-data";
import { LanguageProvider } from "../src/i18n/provider";
import { seedDicts } from "./helpers/locales";

await seedDicts();
const globals = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const baseline: ComboItem = {
  id: "alpha",
  model: "combo/alpha",
  alias: null,
  strategy: "failover",
  stickyLimit: 1,
  defaultEffort: null,
  targets: [{ provider: "openai", model: "gpt-5", clientKey: "first" }],
};
let saved: Map<string, PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLDivElement;
let root: Root;
let writes: Array<{ text: string; resolve: () => void; reject: () => void }>;

beforeEach(async () => {
  saved = new Map(
    globals.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  win = new Window({ url: "http://localhost/" });
  win.localStorage.setItem("ocx-lang", "en");
  for (const key of globals)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === "window"
          ? win
          : key === "IS_REACT_ACT_ENVIRONMENT"
            ? true
            : Reflect.get(win, key),
    });
  writes = [];
  Object.defineProperty(win.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) =>
        new Promise<void>((resolve, reject) =>
          writes.push({
            text,
            resolve,
            reject: () => reject(new Error("Denied")),
          }),
        ),
    },
  });
  Object.defineProperty(win.document, "execCommand", {
    configurable: true,
    value: undefined,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await win.happyDOM.close();
  for (const key of globals) {
    const descriptor = saved.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function render(model = baseline.model) {
  await act(async () =>
    root.render(
      <LanguageProvider>
        <DetailPanel
          baseline={{ ...baseline, model }}
          otherIds={[]}
          otherAliases={[]}
          providerMap={{ openai: {} }}
          providers={[{ name: "openai" }]}
          models={[{ provider: "openai", id: "gpt-5" }]}
          onSaved={() => {}}
          onSave={async () => ({ ok: true })}
          onDirtyChange={() => {}}
        />
      </LanguageProvider>,
    ),
  );
}
function button() {
  return host.querySelector<HTMLButtonElement>(".cwi-copy-chip")!;
}
async function copy() {
  await act(async () => button().click());
}

test("combo copy reports failure, ignores older completions and scopes feedback to the accepted id", async () => {
  await render();
  await copy();
  await copy();
  expect(writes.map((write) => write.text)).toEqual([
    "combo/alpha",
    "combo/alpha",
  ]);
  await act(async () => writes[1]!.reject());
  expect(button().textContent).toBe("Clipboard unavailable");
  await act(async () => writes[0]!.resolve());
  expect(button().textContent).toBe("Clipboard unavailable");
  await copy();
  await render("expert/router");
  await render();
  await act(async () => writes[2]!.resolve());
  expect(button().textContent).toBe("Copy id");
  await copy();
  await act(async () => writes[3]!.resolve());
  expect(button().textContent).toBe("Copied");
});

test("combo copy uses the existing fallback when Clipboard API is unavailable", async () => {
  Object.defineProperty(win.navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  const commands: string[] = [];
  Object.defineProperty(win.document, "execCommand", {
    configurable: true,
    value: (command: string) => {
      commands.push(command);
      return true;
    },
  });
  await render();
  await copy();
  expect(commands).toEqual(["copy"]);
  expect(button().textContent).toBe("Copied");
  expect(document.querySelector("textarea[readonly]")).toBeNull();
});
