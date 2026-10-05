import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ComboItem } from "../src/combo-workspace-data";
import { DetailPanel } from "../src/components/combo-workspace-detail-panel";
import { LanguageProvider } from "../src/i18n/provider";
import { seedDicts } from "./helpers/locales";

await seedDicts();

const GLOBALS = ["window", "document", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const BASELINE: ComboItem = {
  id: "alpha",
  model: "combo/alpha",
  alias: null,
  strategy: "failover",
  stickyLimit: 1,
  defaultEffort: null,
  targets: [{ provider: "openai", model: "gpt-5", clientKey: "first" }],
};
let previous: Map<string, PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLDivElement;
let root: Root;
let pending: Array<{ text: string; settle: (success: boolean) => void }>;

beforeEach(async () => {
  previous = new Map(GLOBALS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  win = new Window({ url: "http://localhost/" });
  win.localStorage.setItem("ocx-lang", "en");
  for (const key of GLOBALS) {
    const value = key === "window" ? win : key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(win, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  pending = [];
  Object.defineProperty(win.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => new Promise<void>((resolve, reject) => {
        pending.push({ text, settle: success => success ? resolve() : reject(new Error("Clipboard denied")) });
      }),
    },
  });
  Object.defineProperty(win.document, "execCommand", { configurable: true, value: undefined });
  host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await win.happyDOM.close();
  for (const key of GLOBALS) {
    const descriptor = previous.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function render(baseline = BASELINE) {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <DetailPanel
          baseline={baseline}
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
    );
  });
  await act(async () => { await new Promise<void>(resolve => win.setTimeout(resolve, 0)); });
}

function copyButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(".cwi-copy-chip");
  if (!button) throw new Error("Copy control not found");
  return button;
}

async function copy() {
  await act(async () => copyButton().click());
}

async function settle(index: number, success: boolean) {
  await act(async () => pending[index]?.settle(success));
}

test.each([
  BASELINE,
  { ...BASELINE, model: "expert/router", alias: "expert/router" },
])("combo copy writes the accepted public model id %j only after clipboard success", async baseline => {
  await render(baseline);
  await copy();
  expect(pending.map(write => write.text)).toEqual([baseline.model]);
  expect(copyButton().textContent).toBe("Copy id");
  await settle(0, true);
  expect(copyButton().textContent).toBe("Copied");
});

test("combo copy reports unavailable when both clipboard paths fail", async () => {
  await render();
  await copy();
  await settle(0, false);
  expect(copyButton().textContent).toBe("Clipboard unavailable");
});

test("combo copy uses the supported legacy fallback when the Clipboard API is absent", async () => {
  const commands: string[] = [];
  Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: undefined });
  Object.defineProperty(win.document, "execCommand", {
    configurable: true,
    value: (command: string) => { commands.push(command); return true; },
  });
  await render();
  await copy();
  expect(commands).toEqual(["copy"]);
  expect(copyButton().textContent).toBe("Copied");
  expect(document.querySelector("textarea[readonly]")).toBeNull();
});

test("an older combo clipboard completion cannot replace the newer attempt's failure", async () => {
  await render();
  await copy();
  await copy();
  await settle(1, false);
  expect(copyButton().textContent).toBe("Clipboard unavailable");
  await settle(0, true);
  expect(copyButton().textContent).toBe("Clipboard unavailable");
});

test("a refreshed public id resets feedback and ignores completion for the previous id", async () => {
  await render();
  await copy();
  await render({ ...BASELINE, model: "expert/router", alias: "expert/router" });
  await settle(0, true);
  expect(copyButton().textContent).toBe("Copy id");
  expect(host.querySelector(".combo-detail-id")?.textContent).toBe("expert/router");
  await copy();
  expect(pending[1]?.text).toBe("expert/router");
  await settle(1, true);
  expect(copyButton().textContent).toBe("Copied");
});

test("returning to an earlier public id does not revive an old pending copy", async () => {
  await render();
  await copy();
  await render({ ...BASELINE, model: "expert/router", alias: "expert/router" });
  await render();
  await settle(0, true);
  expect(copyButton().textContent).toBe("Copy id");
});
