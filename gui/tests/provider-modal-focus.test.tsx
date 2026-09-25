import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import {
  RemoveConfirmDialog,
  UnsavedLeaveDialog,
} from "../src/components/provider-workspace/ProviderDialogs";
import AddProviderModal from "../src/components/AddProviderModal";
import { seedDicts } from "./helpers/locales";

await seedDicts();

const GLOBALS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "KeyboardEvent",
  "IS_REACT_ACT_ENVIRONMENT",
  "fetch",
] as const;
let descriptors: Map<string, PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLDivElement;
let opener: HTMLButtonElement;
let root: Root | undefined;

beforeEach(() => {
  descriptors = new Map(
    GLOBALS.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  win = new Window({ url: "http://localhost/" });
  win.localStorage.setItem("ocx-lang", "en");
  for (const key of GLOBALS) {
    const value =
      key === "window"
        ? win
        : key === "IS_REACT_ACT_ENVIRONMENT"
          ? true
          : key === "fetch"
            ? async () => Response.json({ providers: [] })
            : Reflect.get(win, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  host = document.createElement("div");
  opener = document.createElement("button");
  opener.textContent = "Open provider dialog";
  document.body.append(opener, host);
  root = undefined;
});

afterEach(async () => {
  await unmount();
  await win.happyDOM.close();
  for (const key of GLOBALS) {
    const descriptor = descriptors.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount(node: ReactElement) {
  opener.focus();
  root = (await import("react-dom/client")).createRoot(host);
  await act(async () => {
    root!.render(<LanguageProvider>{node}</LanguageProvider>);
  });
}

async function unmount() {
  if (!root) return;
  await act(async () => {
    root!.unmount();
  });
  root = undefined;
}

async function key(target: Element, name: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", {
    key: name,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

test("remove confirmation focuses Cancel, traps both Tab directions and returns to its opener", async () => {
  await mount(
    <RemoveConfirmDialog
      providerName="example"
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  );
  const [cancel, confirm] = host.querySelectorAll<HTMLButtonElement>("button");
  expect(document.activeElement === cancel).toBe(true);
  expect(
    host.querySelector('[role="alertdialog"]')?.getAttribute("aria-modal"),
  ).toBe("true");
  expect((await key(cancel!, "Tab", true)).defaultPrevented).toBe(true);
  expect(document.activeElement === confirm).toBe(true);
  expect((await key(confirm!, "Tab")).defaultPrevented).toBe(true);
  expect(document.activeElement === cancel).toBe(true);
  opener.focus();
  expect(document.activeElement === cancel).toBe(true);
  await unmount();
  expect(document.activeElement === opener).toBe(true);
});

test("Escape cancels a remove confirmation without confirming", async () => {
  let cancelled = 0;
  let confirmed = 0;
  await mount(
    <RemoveConfirmDialog
      providerName="example"
      onCancel={() => {
        cancelled++;
      }}
      onConfirm={() => {
        confirmed++;
      }}
    />,
  );
  const cancel = host.querySelector("button")!;
  cancel.focus();
  expect((await key(cancel, "Escape")).defaultPrevented).toBe(true);
  expect(cancelled).toBe(1);
  expect(confirmed).toBe(0);
});

test("unsaved confirmation retains the latest pending cancellation guard and skips disabled Save", async () => {
  let cancelled = 0;
  let discarded = 0;
  function Harness() {
    const [saving, setSaving] = useState(false);
    return (
      <UnsavedLeaveDialog
        saving={saving}
        onCancel={() => {
          if (!saving) cancelled++;
        }}
        onDiscard={() => {
          discarded++;
        }}
        onSave={() => setSaving(true)}
      />
    );
  }
  await mount(<Harness />);
  const [cancel, discard, save] =
    host.querySelectorAll<HTMLButtonElement>("button");
  expect(document.activeElement === cancel).toBe(true);
  discard!.focus();
  await act(async () => {
    save!.click();
  });
  expect(save!.disabled).toBe(true);
  expect(document.activeElement === discard).toBe(true);
  expect((await key(discard!, "Tab")).defaultPrevented).toBe(true);
  expect(document.activeElement === cancel).toBe(true);
  await key(cancel!, "Escape");
  expect(cancelled).toBe(0);
  expect(discarded).toBe(0);
});

test("add-provider form traps focus while preserving its existing Close focus and return", async () => {
  await mount(
    <AddProviderModal
      apiBase=""
      existingNames={[]}
      initialCustom
      onClose={() => {}}
      onAdded={() => {}}
    />,
  );
  const close = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Close"]',
  )!;
  const back = [...host.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;
  expect(document.activeElement === close).toBe(true);
  expect((await key(close, "Tab", true)).defaultPrevented).toBe(true);
  expect(document.activeElement === back).toBe(true);
  expect((await key(back, "Tab")).defaultPrevented).toBe(true);
  expect(document.activeElement === close).toBe(true);
  await unmount();
  expect(document.activeElement === opener).toBe(true);
});

test("a nested control that consumes Escape does not dismiss add-provider", async () => {
  let closed = 0;
  await mount(
    <AddProviderModal
      apiBase=""
      existingNames={[]}
      initialCustom
      onClose={() => {
        closed++;
      }}
      onAdded={() => {}}
    />,
  );
  const input = host.querySelector("input")!;
  input.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") event.preventDefault();
    },
    { once: true },
  );
  await key(input, "Escape");
  expect(closed).toBe(0);
  await key(input, "Escape");
  expect(closed).toBe(1);
});

test("a native modal above add-provider owns focus and Escape", async () => {
  let closed = 0;
  await mount(
    <AddProviderModal
      apiBase=""
      existingNames={[]}
      initialCustom
      onClose={() => {
        closed++;
      }}
      onAdded={() => {}}
    />,
  );
  const native = document.createElement("dialog");
  const nativeClose = document.createElement("button");
  nativeClose.textContent = "Native close";
  native.append(nativeClose);
  document.body.append(native);
  native.showModal();
  nativeClose.focus();
  expect(document.activeElement === nativeClose).toBe(true);
  expect((await key(nativeClose, "Tab")).defaultPrevented).toBe(false);
  await key(nativeClose, "Escape");
  expect(closed).toBe(0);
  native.close();
  native.remove();
});

test("cancelling the OAuth warning leaves add-provider open and never starts login", async () => {
  let closed = 0;
  let logins = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/provider-presets"))
      return Response.json({
        providers: [
          {
            id: "anthropic",
            label: "Anthropic",
            adapter: "anthropic",
            baseUrl: "https://api.anthropic.com",
            auth: "oauth",
            oauthProvider: "anthropic",
          },
        ],
      });
    if (url.endsWith("/api/oauth/providers"))
      return Response.json({ providers: ["anthropic"] });
    if (init?.method === "POST" && url.endsWith("/api/oauth/login")) logins++;
    return Response.json({ providers: [] });
  }) as typeof fetch;
  await mount(
    <AddProviderModal
      apiBase="/warning"
      existingNames={[]}
      initialTier="paid"
      onClose={() => {
        closed++;
      }}
      onAdded={() => {}}
    />,
  );
  const click = async (text: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.includes(text),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });
  };
  await click("Anthropic");
  await click("Log in with");
  const warning = host.querySelector<HTMLDialogElement>("dialog[open]")!;
  expect(warning).not.toBeNull();
  const cancel = [
    ...warning.querySelectorAll<HTMLButtonElement>("button"),
  ].find((node) => node.textContent === "Cancel")!;
  cancel.focus();
  await key(cancel, "Escape");
  expect(closed).toBe(0);
  await act(async () => {
    warning.dispatchEvent(new win.Event("cancel", { cancelable: true }));
  });
  expect(host.querySelector("dialog[open]")).toBeNull();
  expect(host.querySelector('[aria-label="Add provider"]')).not.toBeNull();
  expect(closed).toBe(0);
  expect(logins).toBe(0);
  await key(host.querySelector('button[aria-label="Close"]')!, "Escape");
  expect(closed).toBe(1);
});

test("removing the opener restores focus to the nearest surviving section action", async () => {
  const section = document.createElement("section");
  const survivingAction = document.createElement("button");
  survivingAction.textContent = "Add another provider";
  document.body.prepend(section);
  section.append(opener, survivingAction);
  await mount(
    <RemoveConfirmDialog
      providerName="example"
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  );
  opener.remove();
  await unmount();
  expect(document.activeElement === survivingAction).toBe(true);
});

test("unsaved confirmation Escape cancels without discarding or saving the draft", async () => {
  let cancelled = 0;
  let discarded = 0;
  let saved = 0;
  await mount(
    <UnsavedLeaveDialog
      onCancel={() => {
        cancelled++;
      }}
      onDiscard={() => {
        discarded++;
      }}
      onSave={() => {
        saved++;
      }}
    />,
  );
  await key(host.querySelector("button")!, "Escape");
  expect(cancelled).toBe(1);
  expect(discarded).toBe(0);
  expect(saved).toBe(0);
});

test("confirmation body clicks do not cancel while backdrop clicks use the existing cancel action", async () => {
  let cancelled = 0;
  await mount(
    <RemoveConfirmDialog
      providerName="example"
      onCancel={() => {
        cancelled++;
      }}
      onConfirm={() => {}}
    />,
  );
  await act(async () => {
    host.querySelector<HTMLElement>('[role="alertdialog"]')!.click();
  });
  expect(cancelled).toBe(0);
  await act(async () => {
    host.querySelector<HTMLElement>(".dialog-backdrop")!.click();
  });
  expect(cancelled).toBe(1);
});
