import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
  useProviderQuotas,
} from "../src/components/provider-workspace/use-provider-quotas";

/**
 * Per-provider quota fan-out (Leveranciers): one independent fetch per card, dedupe,
 * stale-response drops, bounded backoff with stop, unsupported without retries.
 *
 * Timer-dependent behaviour (backoff, stale flip) is exercised with SHORT REAL timers
 * by injecting `staleAfterMs` / `backoffMs` into the hook — never with a fake clock.
 * A fake clock plus React's scheduler hangs `act()` on hosted CI runners (different
 * MessageChannel path than the dev laptop), which is why every fake-timer variant of
 * these four tests timed out at the 5000ms test timeout there.
 */

const globals = ["document", "window", "navigator", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

type Deferred = { resolve: (r: Response) => void; reject: (e: unknown) => void };
const pending: { url: string; d: Deferred }[] = [];
const seenUrls: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function okReport(name: string, monthlyPercent = 10) {
  return { generatedAt: Date.now(), reports: [{ provider: name, label: name, source: "test", updatedAt: Date.now(), quota: { monthlyPercent } }] };
}
function providerOf(url: string): string {
  return new URL(url, "http://localhost").searchParams.get("provider") ?? "";
}

type HookResult = ReturnType<typeof useProviderQuotas>;
interface MountOptions {
  staleAfterMs?: number;
  backoffMs?: readonly number[];
}

async function mount(providers: string[], opts: MountOptions = {}): Promise<{ seen: { current: HookResult | null } }> {
  const { createRoot } = await import("react-dom/client");
  const seen: { current: HookResult | null } = { current: null };
  function Probe() {
    seen.current = useProviderQuotas({ apiBase: "", providers, cacheKey: "test-quota-seed", ...opts });
    return null;
  }
  await act(async () => {
    root = createRoot(host);
    root.render(<Probe />);
  });
  await act(async () => {
    // Let effects (initial fan-out) land: a few microtask turns suffice with real timers.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
  return { seen };
}

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function microtaskFlush(): Promise<void> {
  // Pure microtask drain inside act — empirically the only flush that reliably lands
  // the fetch→parse→setCard chain (a real setTimeout inside act wedges it, and a fake
  // clock plus React's scheduler hangs hosted CI runners). See the settle-probe notes
  // in the PR body.
  await act(async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  });
}

/** Wait real wall-clock time (only used to let injected short backoff/stale timers fire). */
async function settle(ms = 0): Promise<void> {
  if (ms > 0) await realSleep(ms);
  await microtaskFlush();
}

/** Assert a retry is scheduled ~= now + delay (real-clock slack for CI runners). */
function expectRetryScheduled(nextRetryAt: number | undefined, delayMs: number): void {
  expect(nextRetryAt).toBeDefined();
  const drift = (nextRetryAt as number) - Date.now();
  expect(Math.abs(drift - delayMs)).toBeLessThanOrEqual(25);
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)]));
  win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    sessionStorage: { configurable: true, value: win.sessionStorage },
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  pending.length = 0;
  seenUrls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seenUrls.push(url);
    return await new Promise<Response>((resolve, reject) => pending.push({ url, d: { resolve, reject } }));
  }) as typeof fetch;
});

afterEach(async () => {
  // Teardown must not await act(): an awaited act() unmount can wedge on the
  // happy-dom scheduler (CI hook timeouts). A sync act() flushes the unmount
  // without that awaited handoff; one real-timer macrotask then drains any
  // scheduler callback the commit still queued, while the window and globals
  // are still live (it reads global `window`, so it must fire before close).
  const current = root;
  root = null;
  if (current) {
    act(() => { current.unmount(); });
  }
  await new Promise<void>(resolve => { setTimeout(resolve, 0); });
  win.close();
  for (const k of globals) Object.defineProperty(globalThis, k, { configurable: true, value: previous[k] });
});

function resolveFor(name: string, response: Response, occurrence = 0) {
  const matches = pending.filter(p => providerOf(p.url) === name);
    const found = matches[occurrence];
  if (!found) throw new Error(`no pending request for ${name} (#${occurrence})`);
  pending.splice(pending.indexOf(found), 1);
  found.d.resolve(response);
}

/** Assert a retry is scheduled ~= now + delay (real-clock slack, runner-safe). */
function expectRetryScheduled(nextRetryAt: number | undefined, delayMs: number): void {
  expect(nextRetryAt).toBeDefined();
  const drift = (nextRetryAt as number) - Date.now();
  expect(Math.abs(drift - delayMs)).toBeLessThanOrEqual(50);
}

describe("useProviderQuotas (per-provider fan-out)", () => {
  test("mount fires one independent fetch per provider, in parallel", async () => {
    const { seen } = await mount(["xai", "anthropic"]);
    expect(seenUrls.map(providerOf).sort()).toEqual(["anthropic", "xai"]);
    expect(seen.current!.cards.xai.status).toBe("loading");
    expect(seen.current!.cards.anthropic.status).toBe("loading");

    // The slow provider does not block the fast one.
    resolveFor("anthropic", json(okReport("anthropic")));
    await settle();
    expect(seen.current!.cards.anthropic.status).toBe("ready");
    expect(seen.current!.cards.anthropic.freshAt).toBeGreaterThan(0);
    expect(seen.current!.cards.xai.status).toBe("loading");

    resolveFor("xai", json(okReport("xai")));
    await settle();
    expect(seen.current!.cards.xai.status).toBe("ready");
  });

  test("dedupe: a second non-force fetch for an in-flight provider is skipped", async () => {
    const { seen } = await mount(["xai"]);
    expect(seenUrls.length).toBe(1);
    await act(async () => { seen.current!.refresh("xai", { force: false }); });
    expect(seenUrls.length).toBe(1);
    resolveFor("xai", json(okReport("xai")));
    await settle();
    expect(seen.current!.cards.xai.status).toBe("ready");
  });

  test("race protection: a stale response is dropped; the newer request wins", async () => {
    const { seen } = await mount(["xai"]);
    // Force a second request while the first is still pending.
    await act(async () => { seen.current!.refresh("xai", { force: true }); });
    expect(seenUrls.length).toBe(2);

    // The OLD response arrives first and must be ignored.
    resolveFor("xai", json(okReport("xai", 99)), 0);
    await settle();
    expect(seen.current!.cards.xai.status).not.toBe("ready");

    // The NEW response wins.
    resolveFor("xai", json(okReport("xai", 42)), 0);
    await settle();
    expect(seen.current!.cards.xai.status).toBe("ready");
    expect((seen.current!.cards.xai.report?.quota as { monthlyPercent?: number })?.monthlyPercent).toBe(42);
  });

  test("unsupported providers settle without error and never retry", async () => {
    const { seen } = await mount(["openrouter"]);
    resolveFor("openrouter", json({ generatedAt: Date.now(), reports: [], unsupported: true }));
    await settle();
    expect(seen.current!.cards.openrouter.status).toBe("unsupported");
    expect(seen.current!.cards.openrouter.nextRetryAt).toBeUndefined();
    expect(seenUrls.length).toBe(1);
  });
  test("errors retry with bounded backoff (10s, 30s, 60s) and then stop", async () => {
    // Short real backoff ladder (ms) so the timing behaviour is tested with real timers.
    const backoffMs = [10, 30, 60] as const;
    const { seen } = await mount(["xai"], { backoffMs });
    expect(seenUrls.length).toBe(1);

    const failOnce = async () => {
      resolveFor("xai", json({ generatedAt: Date.now(), reports: [], error: "quota-probe-failed" }));
      await settle();
    };

    await failOnce();
    expect(seen.current!.cards.xai.status).toBe("error");
    expect(seen.current!.cards.xai.attempt).toBe(1);
    expectRetryScheduled(seen.current!.cards.xai.nextRetryAt, backoffMs[0]);

    await settle(backoffMs[0] + 20);
    expect(seenUrls.length).toBe(2);
    await failOnce();
    expect(seen.current!.cards.xai.attempt).toBe(2);
    expectRetryScheduled(seen.current!.cards.xai.nextRetryAt, backoffMs[1]);

    await settle(backoffMs[1] + 20);
    expect(seenUrls.length).toBe(3);
    await failOnce();
    expect(seen.current!.cards.xai.attempt).toBe(3);
    expectRetryScheduled(seen.current!.cards.xai.nextRetryAt, backoffMs[2]);

    await settle(backoffMs[2] + 20);
    expect(seenUrls.length).toBe(4);
    await failOnce();
    // Backoff stops: no nextRetryAt, no fifth request even after a long wait.
    expect(seen.current!.cards.xai.nextRetryAt).toBeUndefined();
    await settle(250);
    expect(seenUrls.length).toBe(4);
  });

  test("a manual refresh recovers an errored card and clears the retry", async () => {
    const { seen } = await mount(["xai"], { backoffMs: [10, 30, 60] });
    resolveFor("xai", json({ generatedAt: Date.now(), reports: [], error: "quota-probe-failed" }));
    await settle();
    expect(seen.current!.cards.xai.status).toBe("error");

    await act(async () => { seen.current!.refresh("xai", { force: true }); });
    expect(seenUrls.length).toBe(2);
    resolveFor("xai", json(okReport("xai")));
    await settle();
    expect(seen.current!.cards.xai.status).toBe("ready");
    expect(seen.current!.cards.xai.attempt).toBe(0);
  });

  test("ready cards flip to stale after the stale bound", async () => {
    // Short stale bound (ms) so the flip happens with real timers.
    const staleAfterMs = 50;
    const { seen } = await mount(["xai"], { staleAfterMs });
    resolveFor("xai", json(okReport("xai")));
    await settle();
    expect(seen.current!.cards.xai.status).toBe("ready");

    // Wait longer than the stale bound + one tick interval (staleAfterMs/2).
    await settle(staleAfterMs + 2 * (staleAfterMs / 2) + 30);
    expect(seen.current!.cards.xai.status).toBe("stale");
    // The last-good report stays visible behind the VEROUDERD stamp.
    expect(seen.current!.cards.xai.report).toBeDefined();
  });

  test("a session seed paints instantly (ready or stale, never skeleton over seed)", async () => {
    const staleAfterMs = 50;
    win.sessionStorage.setItem("test-quota-seed", JSON.stringify({
      xai: { label: "xai", source: "seed", updatedAt: Date.now(), quota: { monthlyPercent: 5 }, freshAt: Date.now() },
      anthropic: { label: "anthropic", source: "seed", updatedAt: Date.now() - 10 * 60_000, quota: { monthlyPercent: 50 }, freshAt: Date.now() - 10 * 60_000 },
    }));
    const { seen } = await mount(["xai", "anthropic"], { staleAfterMs });
    expect(seen.current!.cards.xai.status).toBe("ready");
    expect(seen.current!.cards.anthropic.status).toBe("stale");
    // Seed is instant paint; the background fan-out still runs for freshness.
    expect(seenUrls.length).toBe(2);
  });
});
