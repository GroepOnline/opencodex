import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PosthogClient } from "../src/telemetry/posthog-server";

/**
 * `flush()` drains the whole queue before sending it, so a transient PostHog
 * failure used to lose the batch permanently. These cover the retry contract:
 * transient statuses come back for another attempt, permanent ones do not, and
 * retries stay bounded.
 */
describe("PosthogClient flush retries", () => {
  let home: string;
  let previousHome: string | undefined;
  const originalFetch = globalThis.fetch;
  let statuses: number[];
  let posted: string[][];

  /** Serve one status per flush, then 200 forever. */
  function stubFetch(): void {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { batch: { event: string }[] };
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
    stubFetch();
    setSystemTime(new Date(2025, 0, 8, 12, 0, 0, 0));
  });

  afterEach(() => {
    setSystemTime();
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
});
