import { afterEach, beforeEach, expect, test, describe } from "bun:test";
import { Window } from "happy-dom";
import { normalizeHashPath, replaceHash, navigateHash } from "../src/hash-routing";
import { canonicalHashFor, readRouteFromHash, resolveAppHashChange } from "../src/app-routing";

/**
 * Hash routing contract after WP5 removed the Classic/Workspace split.
 *
 * The cases that survived from the dual-layout era are the ones that were never about
 * the preference: the generic helpers, history semantics, and passive normalization.
 * The legacy `#providers/workspace` deep link is kept as a REDIRECT case — it must land
 * on `#providers` without trapping Back.
 */

describe("hash helpers", () => {
  let win: Window;
  let previous: Record<string, unknown>;
  const keys = ["window", "document"] as const;

  beforeEach(() => {
    previous = Object.fromEntries(keys.map((k) => [k, Reflect.get(globalThis, k)]));
    win = new Window({ url: "http://localhost/#providers" });
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: win },
      document: { configurable: true, value: win.document },
    });
  });

  afterEach(() => {
    for (const k of keys) Object.defineProperty(globalThis, k, { configurable: true, value: previous[k] });
  });

  test("normalizeHashPath strips the leading marker in both forms", () => {
    expect(normalizeHashPath("#providers")).toBe("providers");
    expect(normalizeHashPath("#/providers")).toBe("providers");
    expect(normalizeHashPath("providers")).toBe("providers");
  });

  test("replaceHash does not increase history length", () => {
    const before = win.history.length;
    replaceHash("models", win as unknown as Window & typeof globalThis);
    expect(normalizeHashPath(win.location.hash)).toBe("models");
    expect(win.history.length).toBe(before);
  });

  test("navigateHash creates a deliberate history entry", () => {
    const before = win.history.length;
    navigateHash("models", win as unknown as Window & typeof globalThis);
    expect(normalizeHashPath(win.location.hash)).toBe("models");
    expect(win.history.length).toBeGreaterThan(before);
  });
});

describe("route resolution", () => {
  test("bare view hashes and valid subs resolve without a rewrite", () => {
    for (const view of ["leveranciers", "modellen", "verkeer", "verbruik", "systeem"]) {
      expect(resolveAppHashChange(view).replaceTo).toBeNull();
    }
    for (const sub of ["leveranciers/claude", "modellen/combos", "verkeer/debug", "systeem/storage"]) {
      expect(resolveAppHashChange(sub).replaceTo).toBeNull();
    }
  });

  test("raw hash-prefixed paths exercise the rawHash contract", () => {
    // Legacy hash with "#" prefix should resolve to its canonical view
    const logsAction = resolveAppHashChange("#logs");
    expect(logsAction.replaceTo).toBe("verkeer");
    expect(canonicalHashFor(logsAction.route)).toBe("verkeer");

    const verkeerLogsAction = resolveAppHashChange("#verkeer/logs");
    expect(verkeerLogsAction.replaceTo).toBe("verkeer");
    expect(canonicalHashFor(verkeerLogsAction.route)).toBe("verkeer");

    // Canonical hash with "#" prefix should not rewrite
    const leveranciersAction = resolveAppHashChange("#leveranciers");
    expect(leveranciersAction.replaceTo).toBeNull();
    expect(canonicalHashFor(leveranciersAction.route)).toBe("leveranciers");
  });

  test("every pre-IA page hash redirects to its new view", () => {
    // The 10-page sidebar era is kept alive as legacy redirects: bookmarks and
    // external deep links land on their new home, via replace (never a push).
    const cases: [string, string][] = [
      ["dashboard/providers", "leveranciers"],
      ["dashboard/models", "modellen"],
      ["providers", "leveranciers"],
      ["providers/workspace", "leveranciers"],
      ["codex-auth", "leveranciers"],
      ["claude", "leveranciers/claude"],
      ["grok", "leveranciers/grok"],
      ["models", "modellen"],
      ["combos", "modellen/combos"],
      ["subagents", "modellen/subagents"],
      ["usage", "verbruik"],
      ["logs", "verkeer"],
      ["logs/debug", "verkeer/debug"],
      ["debug", "verkeer/debug"],
      ["startup", "systeem"],
      ["storage", "systeem/storage"],
      ["api", "systeem/api"],
    ];
    for (const [legacy, canonical] of cases) {
      const action = resolveAppHashChange(legacy);
      expect(action.replaceTo).toBe(canonical);
      expect(canonicalHashFor(action.route)).toBe(canonical);
    }
  });

  test("bare #dashboard is the landing view (not a legacy redirect)", () => {
    const action = resolveAppHashChange("dashboard");
    expect(action.replaceTo).toBeNull();
    expect(action.route).toEqual({ view: "dashboard", sub: null });
    expect(readRouteFromHash("#dashboard").view).toBe("dashboard");
  });

  test("legacy heads with unknown tails collapse to the head's new home", () => {
    expect(resolveAppHashChange("codex-auth/accounts").replaceTo).toBe("leveranciers");
    expect(resolveAppHashChange("providers/nope").replaceTo).toBe("leveranciers");
    expect(resolveAppHashChange("models/nope").replaceTo).toBe("modellen");
  });

  test("unknown view subs normalise to the bare view", () => {
    expect(resolveAppHashChange("leveranciers/nope").replaceTo).toBe("leveranciers");
    expect(resolveAppHashChange("systeem/nope").replaceTo).toBe("systeem");
  });

  test("an unknown hash falls back to Dashboard", () => {
    expect(readRouteFromHash("#nonsense").view).toBe("dashboard");
    expect(resolveAppHashChange("nonsense").replaceTo).toBe("dashboard");
  });
});


describe("useAppRouteState (real hook)", () => {
  const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  let previous: Record<(typeof globals)[number], unknown>;
  let win: Window;
  let host: HTMLElement;
  let root: import("react-dom/client").Root | null = null;

  async function mountAt(hash: string, storage?: Storage) {
    win = new Window({ url: `http://localhost/${hash}` });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: win.document },
      window: { configurable: true, value: win },
      navigator: { configurable: true, value: win.navigator },
      localStorage: { configurable: true, value: storage ?? win.localStorage },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(host as never);

    // Lazy imports: a static react-dom/client import binds to the document that existed
    // when the module graph loaded and corrupts sibling suites in the same process.
    const [{ act }, { createRoot }, { useAppRouteState }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("../src/use-app-route-state"),
    ]);
    const seen: { current: ReturnType<typeof useAppRouteState> | null } = { current: null };
    function Probe() {
      seen.current = useAppRouteState();
      return null;
    }
    await act(async () => {
      root = createRoot(host);
      root.render(<Probe />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    return { seen, act };
  }

  beforeEach(() => {
    previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      const { act } = await import("react");
      await act(async () => { current.unmount(); });
      root = null;
    }
    for (const key of globals) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    }
  });

  test("the legacy workspace hash is REPLACED, so Back is not trapped", async () => {
    const { seen, act } = await mountAt("#leveranciers");

    // Build a real prior entry, then navigate onto the legacy hash the way a bookmark
    // or a pasted link would.
    const baseline = win.history.length;
    await act(async () => { seen.current!.navigateTo({ view: "modellen", sub: null }); });
    expect(win.history.length).toBeGreaterThan(baseline);

    const beforeLegacy = win.history.length;
    await act(async () => {
      win.location.hash = "providers/workspace";
      win.dispatchEvent(new win.HashChangeEvent("hashchange"));
      await new Promise((r) => setTimeout(r, 10));
    });

    // The rewrite itself must be a replace, so it adds no entry beyond the navigation.
    expect(normalizeHashPath(win.location.hash)).toBe("leveranciers");
    expect(seen.current!.route.view).toBe("leveranciers");
    expect(win.history.length).toBe(beforeLegacy + 1);

    // And Back must reach the previous view rather than bouncing on a rewritten entry.
    await act(async () => {
      win.history.back();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(normalizeHashPath(win.location.hash)).toBe("modellen");
    expect(seen.current!.route.view).toBe("modellen");
  });

  test("a bookmarked Codex Auth hash opens Leveranciers on the initial load", async () => {
    // `codex-auth` is no longer a view, so the initial state must come from the same
    // resolver `hashchange` uses — a bare reader alone would fall back to the default.
    const { seen } = await mountAt("#codex-auth/accounts");
    expect(seen.current!.route.view).toBe("leveranciers");
    expect(normalizeHashPath(win.location.hash)).toBe("leveranciers");
  });

  test("an unknown suffix is normalised through the hook", async () => {
    const { seen } = await mountAt("#modellen/nope");
    expect(normalizeHashPath(win.location.hash)).toBe("modellen");
    expect(seen.current!.route.view).toBe("modellen");
  });

  test("navigateTo pushes a history entry", async () => {
    const { seen, act } = await mountAt("#leveranciers");
    const before = win.history.length;
    await act(async () => {
      seen.current!.navigateTo({ view: "modellen", sub: "combos" });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(normalizeHashPath(win.location.hash)).toBe("modellen/combos");
    expect(win.history.length).toBeGreaterThan(before);
  });

  test("stale layout-preference keys are cleared on mount", async () => {
    const seed = new Window({ url: "http://localhost/#dashboard" });
    seed.localStorage.setItem("ocx-global-view", "workspace");
    seed.localStorage.setItem("ocx-providers-view", "classic");
    seed.localStorage.setItem("keep-me", "yes");

    await mountAt("#dashboard", seed.localStorage as unknown as Storage);

    expect(seed.localStorage.getItem("ocx-global-view")).toBeNull();
    expect(seed.localStorage.getItem("ocx-providers-view")).toBeNull();
    // Unrelated keys must survive the cleanup.
    expect(seed.localStorage.getItem("keep-me")).toBe("yes");
  });

  test("a throwing storage does not break routing", async () => {
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    } as unknown as Storage;

    const { seen } = await mountAt("#providers/workspace", throwing);
    // Cleanup failure is swallowed; the redirect still happens.
    expect(normalizeHashPath(win.location.hash)).toBe("leveranciers");
    expect(seen.current!.route.view).toBe("leveranciers");
  });
});
