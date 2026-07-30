import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getServerPosthog, PosthogClient, resetServerPosthog } from "../src/telemetry/posthog-server";

/**
 * `flush()` drains the whole queue before sending it, so a transient PostHog
 * failure used to lose the batch permanently. These cover the retry contract:
 * transient statuses come back for another attempt, permanent ones do not, and
 * retries stay bounded.
 */
interface PostedEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
}

describe("PosthogClient telemetry contract", () => {
  let home: string;
  let previousHome: string | undefined;
  const originalFetch = globalThis.fetch;
  let statuses: number[];
  let posted: string[][];
  let bodies: PostedEvent[][];

  /** Serve one status per flush, then 200 forever. */
  function stubFetch(): void {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { batch: PostedEvent[] };
      bodies.push(body.batch);
      posted.push(body.batch.map((entry) => entry.event));
      const status = statuses.shift() ?? 200;
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    previousHome = process.env["OPENCODEX_HOME"];
    home = mkdtempSync(join(tmpdir(), "ocx-posthog-"));
    process.env["OPENCODEX_HOME"] = home;
    statuses = [];
    posted = [];
    bodies = [];
    stubFetch();
    setSystemTime(new Date(2025, 0, 8, 12, 0, 0, 0));
  });

  afterEach(() => {
    setSystemTime();
    resetServerPosthog();
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** Move past the backoff window so the next flush is allowed to send. */
  function advance(ms: number): void {
    setSystemTime(new Date(Date.now() + ms));
  }

  it("retries a batch rejected with 429 instead of dropping it", async () => {
    statuses = [429];
    const client = new PosthogClient("phc_test");
    client.capture("first_event");
    await client.flush();
    expect(posted).toEqual([["first_event"]]);

    advance(60_000);
    client.capture("second_event");
    await client.flush();
    expect(posted[1]).toEqual(["first_event", "second_event"]);
    client.shutdown();
  });

  it("retries a batch rejected with 5xx", async () => {
    statuses = [503];
    const client = new PosthogClient("phc_test");
    client.capture("first_event");
    await client.flush();

    advance(60_000);
    await client.flush();
    expect(posted).toEqual([["first_event"], ["first_event"]]);
    client.shutdown();
  });

  it("backs off instead of retrying immediately after a transient failure", async () => {
    statuses = [503];
    const client = new PosthogClient("phc_test");
    client.capture("first_event");
    await client.flush();

    await client.flush();
    expect(posted).toHaveLength(1);
    client.shutdown();
  });

  it("drops a batch rejected with a permanent status", async () => {
    statuses = [400];
    const client = new PosthogClient("phc_test");
    client.capture("first_event");
    await client.flush();

    advance(60_000);
    client.capture("second_event");
    await client.flush();
    expect(posted).toEqual([["first_event"], ["second_event"]]);
    client.shutdown();
  });

  it("stops retrying after the attempt bound and keeps the queue bounded", async () => {
    statuses = [503, 503, 503, 503];
    const client = new PosthogClient("phc_test");
    client.capture("first_event");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await client.flush();
      advance(60_000);
    }
    // Three attempts total, then the event is discarded rather than retried forever.
    expect(posted).toEqual([["first_event"], ["first_event"], ["first_event"]]);
    client.shutdown();
  });

  it("emits only allowlisted primitive properties", async () => {
    const client = new PosthogClient("phc_test");
    client.capture("proxy_request_terminal", {
      provider: "openai",
      status: 200,
      durationMs: 1234,
      email: "person@example.test",
      filename: "/home/person/secret.ts",
      path: "/home/person",
      access_token: "sk-live-abc",
      refreshToken: "rt-abc",
      prompt: "user text",
      nested: { deep: true },
      longModel: "x".repeat(400),
    });
    await client.flush();
    expect(bodies[0]![0]!.properties).toEqual({
      provider: "openai",
      status: 200,
      durationMs: 1234,
      $lib: "opencodex-server",
    });
  });

  it("caps long allowlisted string values", async () => {
    const client = new PosthogClient("phc_test");
    client.capture("proxy_request_terminal", { model: "m".repeat(400) });
    await client.flush();
    expect(String(bodies[0]![0]!.properties["model"])).toHaveLength(200);
  });

  it("sends at most 50 events per request and drains the remainder", async () => {
    const client = new PosthogClient("phc_test");
    // Crossing MAX_BATCH_SIZE starts a flush mid-loop, so the queue keeps
    // growing while a request is in flight; the drain must stay chunked.
    for (let index = 0; index < 120; index += 1) client.capture(`event_${index}`);
    await client.flush();
    for (let tick = 0; tick < 20 && posted.flat().length < 120; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(posted.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(posted.flat()).toHaveLength(120);
    client.shutdown();
  });

  it("reuses a persisted anonymous distinct id across clients", async () => {
    const first = new PosthogClient("phc_test");
    first.capture("proxy_request_terminal");
    await first.flush();
    first.shutdown();
    expect(existsSync(join(home, "telemetry-id.txt"))).toBe(true);

    const second = new PosthogClient("phc_test");
    second.capture("proxy_request_terminal");
    await second.flush();
    second.shutdown();
    const id = bodies[0]![0]!.distinct_id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodies[1]![0]!.distinct_id).toBe(id);
  });

  it("treats a fetch failure as transient and keeps the batch", async () => {
    globalThis.fetch = (async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
    const client = new PosthogClient("phc_test");
    client.capture("proxy_request_terminal");
    await client.flush();

    advance(60_000);
    stubFetch();
    await client.flush();
    expect(posted).toEqual([["proxy_request_terminal"]]);
    client.shutdown();
  });

  it("gates the singleton on OCX_POSTHOG_KEY and resets cleanly", () => {
    const previousKey = process.env["OCX_POSTHOG_KEY"];
    try {
      delete process.env["OCX_POSTHOG_KEY"];
      expect(getServerPosthog()).toBeNull();

      resetServerPosthog();
      process.env["OCX_POSTHOG_KEY"] = "phc_test";
      const client = getServerPosthog();
      expect(client).not.toBeNull();
      expect(getServerPosthog()).toBe(client);

      resetServerPosthog();
      expect(getServerPosthog()).not.toBe(client);
    } finally {
      if (previousKey === undefined) delete process.env["OCX_POSTHOG_KEY"];
      else process.env["OCX_POSTHOG_KEY"] = previousKey;
    }
  });
});
