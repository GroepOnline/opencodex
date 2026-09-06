import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ModelRow } from "../src/pages/models-shared";
import { LanguageProvider } from "../src/i18n/provider";
import { seedDicts } from "./helpers/locales";

await seedDicts();

const GLOBALS = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "HTMLElement",
  "HTMLInputElement",
  "Element",
  "SVGElement",
  "Node",
  "Document",
  "ShadowRoot",
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
let Models: typeof import("../src/pages/Models").default;
let originalFetch: typeof fetch;
let clipboardDescriptor: PropertyDescriptor | undefined;
let execCommandDescriptor: PropertyDescriptor | undefined;
let models: ModelRow[];
let selected: Record<string, string[]>;
let failVisibility: boolean;
let deletionDelay: Promise<void> | undefined;
let providerRefreshResponse: Promise<Response> | undefined;
let polls: Array<() => void>;
let writes: Array<{
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}>;

beforeEach(async () => {
  descriptors = new Map(
    GLOBALS.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  originalFetch = globalThis.fetch;
  testWindow = new Window({ url: "http://localhost/" });
  clipboardDescriptor = Object.getOwnPropertyDescriptor(
    testWindow.navigator,
    "clipboard",
  );
  execCommandDescriptor = Object.getOwnPropertyDescriptor(
    testWindow.document,
    "execCommand",
  );
  Object.defineProperty(testWindow.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
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
  polls = [];
  Object.defineProperty(testWindow, "setInterval", {
    configurable: true,
    value: (callback: () => void) => {
      polls.push(callback);
      return polls.length;
    },
  });
  models = [
    {
      provider: "alpha",
      id: "shared",
      namespaced: "alpha/shared",
      displayName: "Atlas Vision",
      contextWindow: 128000,
      inputModalities: ["text", "image"],
      disabled: false,
    },
    {
      provider: "beta",
      id: "shared",
      namespaced: "beta/shared",
      displayName: "Boreal",
      disabled: false,
    },
    {
      provider: "alpha",
      id: "hidden",
      namespaced: "alpha/hidden",
      displayName: "Hidden model",
      disabled: false,
    },
  ];
  selected = { alpha: ["shared"], beta: [] };
  failVisibility = false;
  deletionDelay = undefined;
  providerRefreshResponse = undefined;
  writes = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    if (method !== "GET") writes.push({ path, method, body });
    if (path === "/api/model-visibility" && method === "PUT") {
      if (failVisibility)
        return Response.json(
          { error: "visibility update failed" },
          { status: 500 },
        );
      const update = body as {
        provider: string;
        targets: Array<{ id: string }>;
        enabled: boolean;
      };
      models = models.map((model) =>
        model.provider === update.provider &&
        update.targets.some((target) => target.id === model.id)
          ? { ...model, disabled: !update.enabled }
          : model,
      );
      const allowed = selected[update.provider];
      if (update.enabled && allowed?.length) {
        selected[update.provider] = [
          ...new Set([
            ...allowed,
            ...update.targets.map((target) => target.id),
          ]),
        ];
      }
      return Response.json({ ok: true });
    }
    if (path.startsWith("/api/custom-models/") && method === "DELETE") {
      await deletionDelay;
      const id = decodeURIComponent(path.slice("/api/custom-models/".length));
      models = models.filter((model) => model.customId !== id);
      return Response.json({ ok: true });
    }
    if (path === "/api/providers/models/refresh" && method === "POST") {
      if (!providerRefreshResponse)
        throw new Error("Unexpected provider refresh");
      return providerRefreshResponse;
    }
    if (path === "/api/models") return Response.json(models);
    if (path === "/api/providers")
      return Response.json(
        ["alpha", "beta"].map((name) => ({
          name,
          models: models
            .filter((model) => model.provider === name)
            .map((model) => model.id),
          liveModels: false,
        })),
      );
    if (path === "/api/selected-models") return Response.json({ selected });
    if (path === "/api/provider-context-caps")
      return Response.json({ caps: {}, value: 350000 });
    if (path === "/api/combos") return Response.json({ combos: [] });
    if (path === "/api/shadow-call-settings")
      return Response.json({ enabled: false, model: "" });
    if (path === "/api/v2")
      return Response.json({ enabled: false, multiAgentMode: "default" });
    throw new Error(`Unexpected request: ${method} ${path}`);
  }) as typeof fetch;
  root = undefined;
  host = document.createElement("div");
  document.body.append(host);
  // Browser capability detection must happen after globals exist. Keep the package's
  // --isolate runner; never mock Base UI's layout effects to hide environment failures.
  Models = (await import("../src/pages/Models")).default;
});

afterEach(async () => {
  if (root)
    await act(async () => {
      root!.unmount();
    });
  host.remove();
  if (clipboardDescriptor)
    Object.defineProperty(
      testWindow.navigator,
      "clipboard",
      clipboardDescriptor,
    );
  else Reflect.deleteProperty(testWindow.navigator, "clipboard");
  if (execCommandDescriptor)
    Object.defineProperty(
      testWindow.document,
      "execCommand",
      execCommandDescriptor,
    );
  else Reflect.deleteProperty(testWindow.document, "execCommand");
  await testWindow.happyDOM.close();
  globalThis.fetch = originalFetch;
  for (const key of GLOBALS) {
    const descriptor = descriptors.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 10));
  });
}

async function mount() {
  root = (await import("react-dom/client")).createRoot(host);
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <Models apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await settle();
  expect(host.querySelector('[aria-label="Model catalog"]')).not.toBeNull();
}

function button(label: string, scope: ParentNode = host): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) =>
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function switchControl(label: string, scope: ParentNode = host): HTMLElement {
  // Base UI renders a focusable span[role=switch] plus a hidden checkbox,
  // not a button. Exercise its public switch surface, not the hidden input.
  const found = [
    ...scope.querySelectorAll<HTMLElement>('[role="switch"]'),
  ].find((node) => node.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Missing switch: ${label}`);
  return found;
}

function inspector(): HTMLElement {
  return host.querySelector<HTMLElement>("#model-inspector")!;
}
function inspectButtons() {
  return [
    ...host.querySelectorAll<HTMLButtonElement>(
      'button[aria-controls="model-inspector"]',
    ),
  ];
}
async function click(node: HTMLElement) {
  await act(async () => {
    node.click();
  });
  await settle();
}
async function search(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      testWindow.HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}
async function chooseProvider(label: string) {
  await click(button("Providers"));
  const option = [
    ...testWindow.document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((node) => node.textContent === label);
  expect(option).toBeDefined();
  await act(async () => {
    option!.click();
  });
}
async function refresh() {
  await act(async () => {
    for (const poll of polls) poll();
  });
  await settle();
}

test("model workspace opens new-user groups and inspects a provider-qualified identity without mutating visibility", async () => {
  await mount();
  expect(inspectButtons()).toHaveLength(3);
  expect(inspector().textContent).toContain("Select a model");
  const advanced = button("Model settings & advanced controls");
  expect(advanced.getAttribute("aria-expanded")).toBe("false");
  expect(
    host.querySelector(".models-advanced [data-slot=accordion-content]"),
  ).toBeNull();
  for (const options of host.querySelectorAll(".models-provider-options")) {
    expect(
      button("Provider settings", options).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(options.querySelector("[data-slot=accordion-content]")).toBeNull();
  }

  await click(button("Inspect alpha/shared"));
  expect(inspector().querySelector("h3")?.textContent).toBe("Atlas Vision");
  expect(inspector().textContent).toContain("128k");
  expect(inspector().textContent).toContain("text, image");
  expect(document.activeElement === inspector().querySelector("h3")).toBe(true);
  expect(button("Inspect alpha/shared").getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(button("Inspect beta/shared").getAttribute("aria-pressed")).toBe(
    "false",
  );

  await click(button("Inspect beta/shared"));
  expect(inspector().querySelector("h3")?.textContent).toBe("Boreal");
  expect(inspector().querySelector("code")?.textContent).toBe("beta/shared");
  expect(inspector().querySelectorAll("dd")).toHaveLength(2);
  for (const fact of inspector().querySelectorAll("dd"))
    expect(fact.textContent).toBe("Not reported");
  const evidence = inspector().querySelector<HTMLButtonElement>(
    "[data-slot=accordion-trigger]",
  )!;
  expect(evidence.getAttribute("aria-expanded")).toBe("false");
  await click(evidence);
  expect(evidence.getAttribute("aria-expanded")).toBe("true");
  expect(inspector().textContent).toContain("not a live connection test");
  expect(button("Inspect alpha/shared").getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(button("Inspect beta/shared").getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(writes).toEqual([]);

  await click(button("Back to models", inspector()));
  expect(inspector().textContent).toContain("Select a model");
  expect(
    inspectButtons().every(
      (node) => node.getAttribute("aria-pressed") === "false",
    ),
  ).toBe(true);
  expect(document.activeElement === button("Inspect beta/shared")).toBe(true);
  expect(writes).toEqual([]);
});

test("Back restores focus to search when the selected row was collapsed out of the catalog", async () => {
  await mount();
  await click(button("Inspect alpha/shared"));
  const group = button("Inspect alpha/shared").closest(
    ".models-provider-card",
  )!;
  await click(
    group.querySelector<HTMLButtonElement>(".models-provider-toggle")!,
  );
  expect(inspector().querySelector("h3")?.textContent).toBe("Atlas Vision");
  expect(
    inspectButtons().some(
      (node) => node.getAttribute("aria-label") === "Inspect alpha/shared",
    ),
  ).toBe(false);
  await click(button("Back to models", inspector()));
  expect(
    document.activeElement === host.querySelector('input[type="search"]'),
  ).toBe(true);
  expect(writes).toEqual([]);
});

test("global search matches display names and providers through persisted collapsed groups without changing the preference", async () => {
  testWindow.localStorage.setItem(
    "ocx-models-collapsed:v2",
    JSON.stringify(["alpha"]),
  );
  await mount();
  expect(
    inspectButtons().map((node) => node.getAttribute("aria-label")),
  ).toEqual(["Inspect beta/shared"]);
  await search("  ATLAS VISION  ");
  expect(
    inspectButtons().map((node) => node.getAttribute("aria-label")),
  ).toEqual(["Inspect alpha/shared"]);
  await click(button("Inspect alpha/shared"));
  await search("BeTa");
  expect(inspector().textContent).toContain("Select a model");
  expect(
    inspectButtons().map((node) => node.getAttribute("aria-label")),
  ).toEqual(["Inspect beta/shared"]);
  await search("nothing-matches-this");
  expect(inspectButtons()).toHaveLength(0);
  expect(host.textContent).toContain("No matching models");
  await click(button("Clear search"));
  expect(
    inspectButtons().map((node) => node.getAttribute("aria-label")),
  ).toEqual(["Inspect beta/shared"]);
  expect(
    JSON.parse(testWindow.localStorage.getItem("ocx-models-collapsed:v2")!),
  ).toEqual(["alpha"]);
  expect(writes).toEqual([]);
});

test("provider filtering clears the inspector and combines with the global search", async () => {
  await mount();
  await click(button("Inspect alpha/shared"));
  await chooseProvider("beta");
  expect(inspector().textContent).toContain("Select a model");
  expect(
    inspectButtons().map((node) => node.getAttribute("aria-label")),
  ).toEqual(["Inspect beta/shared"]);
  await search("Atlas Vision");
  expect(inspectButtons()).toHaveLength(0);
  expect(host.textContent).toContain("No matching models");
  await chooseProvider("All providers");
  expect(
    inspectButtons().map((node) => node.getAttribute("aria-label")),
  ).toEqual(["Inspect alpha/shared"]);
  expect(writes).toEqual([]);
});

test("model search input-group clear action resets filtering and returns focus to the real search input", async () => {
  await mount();
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  const group = input.closest('[data-slot="input-group"]')!;
  expect(group).not.toBeNull();
  expect(input.getAttribute("data-slot")).toBe("input-group-control");
  expect(input.getAttribute("aria-label")).toBe("Search models or providers…");
  await search("Atlas Vision");
  expect(inspectButtons()).toHaveLength(1);
  const clear = button("Clear search", group);
  clear.focus();
  await click(clear);
  expect(input.value).toBe("");
  expect(document.activeElement === input).toBe(true);
  expect(inspectButtons()).toHaveLength(3);
  expect(group.querySelector('button[aria-label="Clear search"]')).toBeNull();
  expect(writes).toEqual([]);
});

test("model accordions expose associated panels only after activation and keep provider actions independent of collapse", async () => {
  await mount();
  const group = button("Inspect alpha/shared").closest(
    ".models-provider-card",
  )!;
  const toggle = group.querySelector<HTMLButtonElement>(
    ".models-provider-toggle",
  )!;
  const settings = button("Provider settings", group);
  expect(group.querySelector(".models-provider-actions")).toBeNull();
  expect(settings.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await click(settings);
  expect(settings.getAttribute("aria-expanded")).toBe("true");
  const panelId = settings.getAttribute("aria-controls");
  expect(panelId).toBeTruthy();
  const panel = document.getElementById(panelId!);
  expect(panel?.contains(button("Fetch models", group))).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await click(settings);
  expect(settings.getAttribute("aria-expanded")).toBe("false");
  expect(group.querySelector(".models-provider-actions")).toBeNull();

  const advanced = button("Model settings & advanced controls");
  expect(
    host.querySelector(".models-advanced [data-slot=accordion-content]"),
  ).toBeNull();
  await click(advanced);
  expect(advanced.getAttribute("aria-expanded")).toBe("true");
  expect(
    host.querySelector(
      '.models-advanced button.select-trigger[aria-label="Shadow Call Intercept"]',
    ),
  ).not.toBeNull();
  await click(advanced);
  expect(advanced.getAttribute("aria-expanded")).toBe("false");
  expect(
    host.querySelector(".models-advanced [data-slot=accordion-content]"),
  ).toBeNull();
  expect(writes).toEqual([]);
});

for (const outcome of ["success", "error"] as const) {
  test(`provider refresh Spinner is present only while the request is pending and settles on ${outcome}`, async () => {
    let finishRefresh!: (response: Response) => void;
    providerRefreshResponse = new Promise<Response>((resolve) => {
      finishRefresh = resolve;
    });
    await mount();
    const group = button("Inspect alpha/shared").closest(
      ".models-provider-card",
    )!;
    await click(button("Provider settings", group));
    expect(host.querySelector('[data-slot="spinner"]')).toBeNull();
    await click(button("Fetch models", group));
    const pending = button("Fetching…", group);
    expect(pending.disabled).toBe(true);
    expect(pending.querySelectorAll('[data-slot="spinner"]')).toHaveLength(1);
    expect(writes).toEqual([
      { path: "/api/providers/models/refresh", method: "POST", body: null },
    ]);
    await act(async () => {
      finishRefresh(
        outcome === "success"
          ? Response.json({ ok: true, count: 2, models: ["shared", "hidden"] })
          : Response.json({ error: "Discovery unavailable" }, { status: 503 }),
      );
    });
    await settle();
    expect(host.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(button("Fetch models", group).disabled).toBe(false);
    expect(host.textContent).toContain(
      outcome === "success"
        ? "Fetched 2 models from alpha."
        : "Could not fetch models: Discovery unavailable",
    );
    expect(writes).toHaveLength(1);
  });
}

test("search-expanded groups disable collapse controls without overwriting the persisted preference", async () => {
  testWindow.localStorage.setItem(
    "ocx-models-collapsed:v2",
    JSON.stringify(["alpha"]),
  );
  await mount();
  await search("alpha");
  const providerToggle = host.querySelector<HTMLButtonElement>(
    ".models-provider-toggle",
  )!;
  expect(providerToggle.disabled).toBe(true);
  expect(providerToggle.getAttribute("aria-expanded")).toBe("true");
  expect(button("Collapse all").disabled).toBe(true);
  expect(button("Expand all").disabled).toBe(true);
  await click(providerToggle);
  await click(button("Collapse all"));
  await click(button("Expand all"));
  expect(inspectButtons()).toHaveLength(2);
  expect(
    JSON.parse(testWindow.localStorage.getItem("ocx-models-collapsed:v2")!),
  ).toEqual(["alpha"]);

  await search("");
  expect(
    host.querySelector<HTMLButtonElement>(".models-provider-toggle")?.disabled,
  ).toBe(false);
  expect(
    host
      .querySelector(".models-provider-toggle")
      ?.getAttribute("aria-expanded"),
  ).toBe("false");
  expect(button("Collapse all").disabled).toBe(false);
  expect(button("Expand all").disabled).toBe(false);
  expect(
    inspectButtons().map((node) => node.getAttribute("aria-label")),
  ).toEqual(["Inspect beta/shared"]);
  expect(writes).toEqual([]);
});

test("selected details track refreshed catalog metadata and stop displaying a removed model", async () => {
  await mount();
  await click(button("Inspect alpha/shared"));
  models = models.map((model) =>
    model.namespaced === "alpha/shared"
      ? {
          ...model,
          displayName: "Atlas revised",
          contextWindow: 256000,
          inputModalities: ["text"],
        }
      : model,
  );
  await refresh();
  expect(inspector().querySelector("h3")?.textContent).toBe("Atlas revised");
  expect(inspector().textContent).toContain("256k");
  expect(inspector().textContent).not.toContain("text, image");
  expect(button("Inspect alpha/shared").getAttribute("aria-pressed")).toBe(
    "true",
  );
  models = models.filter((model) => model.namespaced !== "alpha/shared");
  await refresh();
  expect(inspector().textContent).toContain("Select a model");
  expect(inspector().textContent).not.toContain("Atlas revised");
  expect(
    host
      .querySelector(".models-workspace-root")
      ?.classList.contains("has-selection"),
  ).toBe(false);
  expect(writes).toEqual([]);
});

for (const removalSource of ["refresh", "confirmed deletion"] as const) {
  for (const focusLocation of ["inspector", "elsewhere"] as const) {
    test(`${removalSource} clears removed selection without resurrection and handles focus ${focusLocation}`, async () => {
      const removedModel = {
        ...models[0]!,
        custom: true,
        customId: "custom/atlas",
      };
      models[0] = removedModel;
      await mount();
      await click(button("Inspect alpha/shared"));
      const outsideControl = button("Providers");
      const searchInput = host.querySelector<HTMLInputElement>(
        'input[type="search"]',
      )!;

      if (removalSource === "confirmed deletion") {
        // Keep the response pending so the user can legitimately move focus away
        // before the accepted reload removes the inspector content.
        let finishDeletion!: () => void;
        deletionDelay = new Promise<void>((resolve) => {
          finishDeletion = resolve;
        });
        Object.defineProperty(testWindow, "confirm", {
          configurable: true,
          value: () => true,
        });
        const deleteButton = button("Delete", inspector());
        deleteButton.focus();
        await act(async () => {
          deleteButton.click();
        });
        expect(writes).toEqual([
          {
            path: "/api/custom-models/custom%2Fatlas",
            method: "DELETE",
            body: null,
          },
        ]);
        expect(inspector().querySelector("h3")?.textContent).toBe(
          "Atlas Vision",
        );
        if (focusLocation === "elsewhere") outsideControl.focus();
        expect(
          Boolean(document.activeElement?.closest("#model-inspector")),
        ).toBe(focusLocation === "inspector");
        await act(async () => {
          finishDeletion();
        });
        await settle();
      } else {
        if (focusLocation === "inspector")
          switchControl("Show selected model in picker", inspector()).focus();
        else outsideControl.focus();
        expect(
          Boolean(document.activeElement?.closest("#model-inspector")),
        ).toBe(focusLocation === "inspector");
        models = models.filter(
          (model) => model.namespaced !== removedModel.namespaced,
        );
        await refresh();
        expect(writes).toEqual([]);
      }

      expect(inspector().textContent).toContain("Select a model");
      expect(inspector().textContent).not.toContain("Atlas Vision");
      expect(
        host
          .querySelector(".models-workspace-root")
          ?.classList.contains("has-selection"),
      ).toBe(false);
      expect(
        inspectButtons().every(
          (node) => node.getAttribute("aria-pressed") === "false",
        ),
      ).toBe(true);
      const expectedFocus =
        focusLocation === "inspector" ? searchInput : outsideControl;
      expect(document.activeElement === expectedFocus).toBe(true);

      // Re-discovery of the same provider-qualified identity must not revive a
      // selection which was already removed by an accepted catalog generation.
      models = [removedModel, ...models];
      await refresh();
      expect(button("Inspect alpha/shared").getAttribute("aria-pressed")).toBe(
        "false",
      );
      expect(inspector().textContent).toContain("Select a model");
      expect(
        host
          .querySelector(".models-workspace-root")
          ?.classList.contains("has-selection"),
      ).toBe(false);
      expect(document.activeElement === expectedFocus).toBe(true);
      expect(writes).toHaveLength(
        removalSource === "confirmed deletion" ? 1 : 0,
      );
    });
  }
}

test("inspector and row switches use the same allowlist visibility and provider-qualified mutation", async () => {
  await mount();
  await click(button("Inspect alpha/hidden"));
  expect(switchControl("alpha/hidden").getAttribute("role")).toBe("switch");
  expect(switchControl("alpha/hidden").getAttribute("aria-checked")).toBe(
    "false",
  );
  expect(
    switchControl("Show selected model in picker", inspector()).getAttribute(
      "role",
    ),
  ).toBe("switch");
  expect(
    switchControl("Show selected model in picker", inspector()).getAttribute(
      "aria-checked",
    ),
  ).toBe("false");
  expect(inspector().textContent).toContain("Excluded by your model settings");
  await click(switchControl("Show selected model in picker", inspector()));
  expect(writes).toEqual([
    {
      path: "/api/model-visibility",
      method: "PUT",
      body: {
        scope: "models",
        provider: "alpha",
        targets: [{ id: "hidden", native: false }],
        enabled: true,
      },
    },
  ]);
  expect(switchControl("alpha/hidden").getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(
    switchControl("Show selected model in picker", inspector()).getAttribute(
      "aria-checked",
    ),
  ).toBe("true");
  await click(switchControl("alpha/hidden"));
  expect(
    switchControl("Show selected model in picker", inspector()).getAttribute(
      "aria-checked",
    ),
  ).toBe("false");
  expect(button("Inspect alpha/hidden").getAttribute("aria-pressed")).toBe(
    "true",
  );

  await click(button("Inspect beta/shared"));
  await click(switchControl("Show selected model in picker", inspector()));
  expect(writes.at(-1)?.body).toEqual({
    scope: "models",
    provider: "beta",
    targets: [{ id: "shared", native: false }],
    enabled: false,
  });
  expect(switchControl("beta/shared").getAttribute("aria-checked")).toBe(
    "false",
  );
  expect(switchControl("alpha/shared").getAttribute("aria-checked")).toBe(
    "true",
  );
});

test("failed visibility writes keep both switches at the server state and expose the failure", async () => {
  await mount();
  await click(button("Inspect alpha/hidden"));
  failVisibility = true;
  await click(switchControl("Show selected model in picker", inspector()));
  expect(writes).toHaveLength(1);
  expect(host.textContent).toContain("Save failed");
  expect(switchControl("alpha/hidden").getAttribute("aria-checked")).toBe(
    "false",
  );
  expect(
    switchControl("Show selected model in picker", inspector()).getAttribute(
      "aria-checked",
    ),
  ).toBe("false");
  expect(button("Inspect alpha/hidden").getAttribute("aria-pressed")).toBe(
    "true",
  );
});

test("custom inspector actions edit the selected identity and only delete after confirmation", async () => {
  models[0] = { ...models[0]!, custom: true, customId: "custom/atlas" };
  await mount();
  await click(button("Inspect alpha/shared"));
  await click(button("Edit", inspector()));
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.querySelector("h3")?.textContent).toBe(
    "Edit custom model — alpha",
  );
  const fields = [...dialog.querySelectorAll<HTMLInputElement>("input")];
  expect(fields.map((field) => field.value)).toContain("shared");
  expect(fields.map((field) => field.value)).toContain("Atlas Vision");
  await click(button("Close", dialog));
  expect(writes).toEqual([]);

  Object.defineProperty(testWindow, "confirm", {
    configurable: true,
    value: () => false,
  });
  await click(button("Delete", inspector()));
  expect(writes).toEqual([]);
  expect(inspector().querySelector("h3")?.textContent).toBe("Atlas Vision");
  Object.defineProperty(testWindow, "confirm", {
    configurable: true,
    value: () => true,
  });
  await click(button("Delete", inspector()));
  expect(writes).toEqual([
    { path: "/api/custom-models/custom%2Fatlas", method: "DELETE", body: null },
  ]);
  expect(inspector().textContent).toContain("Select a model");
  expect(host.textContent).toContain("Custom model deleted");
});

function installClipboard(
  writeText: (text: string) => Promise<void>,
  execCommand: (command: string) => boolean = () => false,
) {
  Object.defineProperty(testWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  Object.defineProperty(testWindow.document, "execCommand", {
    configurable: true,
    value: execCommand,
  });
}

function inspectorCopyOutcome(): string | null {
  return (
    inspector()
      .querySelector(".model-inspector-identifier")
      ?.getAttribute("data-copy-outcome") ?? null
  );
}

test("inspector Copy ID writes the exact namespaced model ID and scopes success to that selection", async () => {
  const copied: string[] = [];
  const fallbackCalls: string[] = [];
  installClipboard(
    async (text) => {
      copied.push(text);
    },
    (command) => {
      fallbackCalls.push(command);
      return false;
    },
  );
  await mount();
  await click(button("Inspect alpha/shared"));
  expect(inspectorCopyOutcome()).toBeNull();
  await click(button("Copy ID", inspector()));
  expect(copied).toEqual(["alpha/shared"]);
  expect(fallbackCalls).toEqual([]);
  expect(inspectorCopyOutcome()).toBe("copied");
  expect(
    button("Copied", inspector()).querySelectorAll('svg[aria-hidden="true"]'),
  ).toHaveLength(1);
  expect(
    button("Copied", inspector()).querySelector('[aria-live="polite"]')
      ?.textContent,
  ).toBe("Copied");

  // These rows deliberately share the bare ID: the feedback scope must include
  // the provider, not merely the model ID or current inspector instance.
  await click(button("Inspect beta/shared"));
  expect(button("Copy ID", inspector()).textContent).toBe("Copy ID");
  expect(inspector().textContent).not.toContain("Copied");
  expect(inspectorCopyOutcome()).toBeNull();
  expect(button("Copy ID", inspector()).querySelector("svg")).toBeNull();
  expect(copied).toEqual(["alpha/shared"]);
  expect(writes).toEqual([]);
});

test("inspector Copy ID copies native models as bare IDs rather than routing namespaces", async () => {
  const copied: string[] = [];
  installClipboard(async (text) => {
    copied.push(text);
  });
  models.push({
    provider: "openai",
    id: "gpt-5-native",
    namespaced: "openai/gpt-5-native",
    native: true,
    disabled: false,
  });
  await mount();
  await click(button("Inspect gpt-5-native"));
  expect(inspector().querySelector("code")?.textContent).toBe("gpt-5-native");
  await click(button("Copy ID", inspector()));
  expect(copied).toEqual(["gpt-5-native"]);
  expect(button("Copied", inspector()).textContent).toBe("Copied");
  expect(inspectorCopyOutcome()).toBe("copied");
  expect(writes).toEqual([]);
});

test("inspector Copy ID reports unavailable clipboard honestly and clears that feedback for another model", async () => {
  const attempted: string[] = [];
  const fallbackCalls: string[] = [];
  installClipboard(
    async (text) => {
      attempted.push(text);
      throw new Error("Clipboard permission denied");
    },
    (command) => {
      fallbackCalls.push(command);
      return false;
    },
  );
  await mount();
  await click(button("Inspect alpha/shared"));
  await click(button("Copy ID", inspector()));
  expect(attempted).toEqual(["alpha/shared"]);
  expect(fallbackCalls).toEqual(["copy"]);
  expect(
    button("Clipboard unavailable", inspector()).querySelector(
      '[aria-live="polite"]',
    )?.textContent,
  ).toBe("Clipboard unavailable");
  expect(inspectorCopyOutcome()).toBe("unavailable");
  expect(inspector().querySelector('[data-copy-outcome="copied"]')).toBeNull();
  expect(
    button("Clipboard unavailable", inspector()).querySelector("svg"),
  ).toBeNull();
  expect(inspector().textContent).not.toContain("Copied");
  expect(testWindow.document.querySelector("textarea")).toBeNull();

  await click(button("Inspect beta/shared"));
  expect(button("Copy ID", inspector()).textContent).toBe("Copy ID");
  expect(inspector().textContent).not.toContain("Clipboard unavailable");
  expect(inspector().textContent).not.toContain("Copied");
  expect(inspectorCopyOutcome()).toBeNull();
  expect(writes).toEqual([]);
});

test("inspector Copy ID cannot display a late completion over a different selected model", async () => {
  const copied: string[] = [];
  let finishFirstCopy!: () => void;
  const firstCopy = new Promise<void>((resolve) => {
    finishFirstCopy = resolve;
  });
  installClipboard(async (text) => {
    copied.push(text);
    if (text === "alpha/shared") await firstCopy;
  });
  await mount();
  await click(button("Inspect alpha/shared"));
  await click(button("Copy ID", inspector()));
  expect(copied).toEqual(["alpha/shared"]);
  await click(button("Inspect beta/shared"));
  expect(button("Copy ID", inspector()).textContent).toBe("Copy ID");
  await act(async () => {
    finishFirstCopy();
  });
  await settle();
  expect(button("Copy ID", inspector()).textContent).toBe("Copy ID");
  expect(inspector().textContent).not.toContain("Copied");
  expect(inspectorCopyOutcome()).toBeNull();
  await click(button("Copy ID", inspector()));
  expect(copied).toEqual(["alpha/shared", "beta/shared"]);
  expect(button("Copied", inspector()).textContent).toBe("Copied");
  expect(inspectorCopyOutcome()).toBe("copied");
  expect(writes).toEqual([]);
});
