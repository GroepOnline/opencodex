import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { OAuthAccountRow, ProviderAuthHandlers } from "../src/components/provider-workspace/types";

import { seedDicts } from "./helpers/locales";

await seedDicts();

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "fetch"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
const originalFetch = globalThis.fetch;

const HANDLERS: ProviderAuthHandlers = {
  onLogin: () => {},
  onLogout: () => {},
  onReauth: () => {},
  onSwitchAccount: () => {},
  onRemoveAccount: () => {},
  onAddApiKey: async () => true,
  onSwitchApiKey: () => {},
  onRemoveApiKey: () => {},
  onEditAlias: () => {},
  onRetryAccounts: () => {},
};

const CURSOR_ITEM: WorkspaceItem = {
  name: "cursor",
  adapter: "cursor",
  baseUrl: "https://api2.cursor.sh",
  authMode: "oauth",
};

const ANTHROPIC_ITEM: WorkspaceItem = {
  name: "anthropic",
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  authMode: "oauth",
};

function stubPoolFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/oauth/accounts/pool")) {
      return new Response(JSON.stringify({
        enabled: false,
        autoSwitchThreshold: 80,
        strategy: "quota",
        stickyLimit: 1,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://127.0.0.1:10100/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  win.localStorage.setItem("ocx-lang", "en");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  stubPoolFetch();
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  globalThis.fetch = originalFetch;
  for (const key of globals) {
    if (key === "fetch") continue;
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  await win.happyDOM?.close?.();
});

async function mountPanel(item: WorkspaceItem, accounts: OAuthAccountRow[] = []) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={item}
          apiBase="http://127.0.0.1:10100"
          accounts={accounts}
          authHandlers={HANDLERS}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

test("Cursor oauth surface shows the account pool and API-key import, not Claude copy", async () => {
  await mountPanel(CURSOR_ITEM, [{
    id: "acct-1",
    email: "one@cursor.test",
    active: true,
  }]);

  expect(host.textContent).toContain("Cursor account pool (experimental)");
  expect(host.textContent).toContain("Add Cursor API key");
  expect(host.textContent).not.toContain("Claude account pool");
  expect(host.textContent).not.toContain("Anthropic may restrict");
});

test("Anthropic oauth surface keeps the Claude pool and never offers a Cursor API key paste", async () => {
  await mountPanel(ANTHROPIC_ITEM, [{
    id: "acct-1",
    email: "one@anthropic.test",
    active: true,
  }]);

  expect(host.textContent).toContain("Claude account pool (experimental)");
  expect(host.textContent).not.toContain("Add Cursor API key");
});

test("cooldown rows expose a clear-cooldown control", async () => {
  await mountPanel(CURSOR_ITEM, [{
    id: "acct-cool",
    email: "cool@cursor.test",
    active: true,
    health: { status: "cooldown", until: new Date(Date.now() + 60_000).toISOString() },
  }]);

  expect(host.textContent).toContain("Clear cooldown");
});
