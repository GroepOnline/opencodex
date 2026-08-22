import { describe, expect, test } from "bun:test";
import {
  classifyCursorUpstreamOutcome,
  classifyGenericUpstreamOutcome,
  classifyGoogleUpstreamOutcome,
  classifyUpstreamOutcome,
  upstreamOutcomePolicy,
  type UpstreamOutcomeLabel,
} from "../src/lib/upstream-outcome";
import {
  createUpstreamAttemptBudget,
  OCX_MAX_UPSTREAM_ATTEMPTS,
} from "../src/lib/upstream-attempt-budget";
import {
  fetchWithTransientRetry,
  MAX_INTERNAL_RETRY_AFTER_MS,
  retryAfterExceedsInternalLimit,
} from "../src/lib/upstream-retry";
import {
  ARCHITECTURE_CONTRACT_ROWS,
  CURSOR_ADAPTER_EOF_FIXTURES,
  CURSOR_CLIENT_ABORT_FIXTURES,
  CURSOR_RATE_LIMIT_FIXTURES,
} from "./fixtures/cursor-log-outcomes";

describe("unified upstream outcome labels", () => {
  test("architecture contract table policies", () => {
    for (const row of ARCHITECTURE_CONTRACT_ROWS) {
      const policy = upstreamOutcomePolicy(row.label as UpstreamOutcomeLabel);
      expect(policy.sameAccountRetry).toBe(row.sameAccountRetry);
      expect(policy.rotateOrCool).toBe(row.rotateOrCool);
    }
  });

  test("per-rail adapters keep the same overflow / abort / eof decisions", () => {
    const overflow = {
      status: 400,
      message: "Your input exceeds the context window of this model",
    };
    expect(classifyGenericUpstreamOutcome(overflow)).toBe("context-overflow");
    expect(classifyCursorUpstreamOutcome(overflow)).toBe("context-overflow");
    expect(classifyGoogleUpstreamOutcome(overflow)).toBe("context-overflow");
    expect(upstreamOutcomePolicy("context-overflow").rotateOrCool).toBe(false);
  });

  test("Cursor log fixtures: abort and adapter_eof are not rotate-worthy", () => {
    for (const fixture of CURSOR_CLIENT_ABORT_FIXTURES) {
      const label = classifyCursorUpstreamOutcome({
        status: fixture.status,
        message: fixture.message,
      });
      expect(label).toBe("client-abort");
      expect(upstreamOutcomePolicy(label).rotateOrCool).toBe(false);
      expect(upstreamOutcomePolicy(label).sameAccountRetry).toBe(false);
    }
    for (const fixture of CURSOR_ADAPTER_EOF_FIXTURES) {
      const label = classifyCursorUpstreamOutcome({
        status: fixture.status,
        message: fixture.message,
      });
      expect(label).toBe("adapter-eof");
      expect(upstreamOutcomePolicy(label).rotateOrCool).toBe(false);
      expect(upstreamOutcomePolicy(label).sameAccountRetry).toBe(false);
    }
  });

  test("Cursor log fixtures: rate-limit remains rotate-eligible", () => {
    for (const fixture of CURSOR_RATE_LIMIT_FIXTURES) {
      const label = classifyCursorUpstreamOutcome({
        status: fixture.status,
        message: fixture.message,
      });
      expect(label).toBe("rate-limit");
      expect(upstreamOutcomePolicy(label).rotateOrCool).toBe(true);
    }
  });

  test("HTTP 402 is quota-exhausted with rotate-eligible policy", () => {
    const evidence = {
      status: 402,
      message: "You have reached your weekly limit. The limit resets in 1d 22h.",
    };
    expect(classifyGenericUpstreamOutcome(evidence)).toBe("quota-exhausted");
    expect(upstreamOutcomePolicy("quota-exhausted").rotateOrCool).toBe(true);
  });

  test("HTTP 529 and overloaded_error hop immediately without same-account retry", () => {
    for (const evidence of [
      { status: 529 },
      { status: 529, message: "Overloaded" },
      { message: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' },
    ]) {
      const label = classifyGenericUpstreamOutcome(evidence);
      expect(label).toBe("overload");
      expect(upstreamOutcomePolicy(label).rotateOrCool).toBe(true);
      expect(upstreamOutcomePolicy(label).sameAccountRetry).toBe(false);
      expect(upstreamOutcomePolicy(label).failover).toBe(true);
    }
  });

  test("502/503 server-overloaded copy stays same-account-retry, not pool rotation", () => {
    const label = classifyCursorUpstreamOutcome({
      status: 502,
      message: "Cursor server overloaded: Provider error 502",
    });
    expect(label).toBe("transient-transport");
    expect(upstreamOutcomePolicy(label).rotateOrCool).toBe(false);
    expect(upstreamOutcomePolicy(label).sameAccountRetry).toBe(true);
  });

  test("400 and 413 never hop", () => {
    expect(classifyGenericUpstreamOutcome({ status: 400, message: "bad request" })).toBe("invalid-request");
    expect(classifyGenericUpstreamOutcome({ status: 413, message: "request too large" })).toBe("invalid-request");
    expect(upstreamOutcomePolicy("invalid-request").rotateOrCool).toBe(false);
    expect(upstreamOutcomePolicy("invalid-request").failover).toBe(false);
  });

  test("context-overflow wins over RESOURCE_EXHAUSTED / 429 wording", () => {
    const label = classifyUpstreamOutcome("google", {
      status: 429,
      message: "RESOURCE_EXHAUSTED: input exceeds the context window",
    });
    expect(label).toBe("context-overflow");
    expect(upstreamOutcomePolicy(label).rotateOrCool).toBe(false);
    expect(upstreamOutcomePolicy(label).sameAccountRetry).toBe(false);
  });

  test("classifier never encodes systemd or tunnel actions", async () => {
    const source = await Bun.file(
      new URL("../src/lib/upstream-outcome.ts", import.meta.url),
    ).text();
    expect(source.toLowerCase()).not.toContain("systemd");
    expect(source.toLowerCase()).not.toContain("tunnel");
    expect(source.toLowerCase()).not.toContain("systemctl");
  });
});

describe("global OCX attempt budget", () => {
  test(`defaults to ${OCX_MAX_UPSTREAM_ATTEMPTS} physical sends`, () => {
    const budget = createUpstreamAttemptBudget();
    expect(budget.limit).toBe(3);
    expect(budget.tryBegin()).toBe(true);
    expect(budget.tryBegin()).toBe(true);
    expect(budget.tryBegin()).toBe(true);
    expect(budget.tryBegin()).toBe(false);
    expect(budget.used).toBe(3);
    expect(budget.remaining).toBe(0);
  });

  test("shared budget stops transient 5xx retries before a fourth send", async () => {
    const budget = createUpstreamAttemptBudget();
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => {
      calls += 1;
      return new Response("boom", { status: 502 });
    }, { attemptBudget: budget, slowAttemptMs: 60_000 });
    expect(res.status).toBe(502);
    expect(calls).toBe(3);
    expect(budget.remaining).toBe(0);
  });
});

describe("Retry-After fail-fast", () => {
  test("Retry-After above 60s is not slept by OCX", () => {
    expect(MAX_INTERNAL_RETRY_AFTER_MS).toBe(60_000);
    expect(retryAfterExceedsInternalLimit(new Headers({ "retry-after": "61" }))).toBe(true);
    expect(retryAfterExceedsInternalLimit(new Headers({ "retry-after": "30" }))).toBe(false);
  });

  test("transient retry returns immediately when Retry-After exceeds 60s", async () => {
    let calls = 0;
    const started = Date.now();
    const res = await fetchWithTransientRetry(async () => {
      calls += 1;
      return new Response("slow", {
        status: 503,
        headers: { "retry-after": "120" },
      });
    }, { slowAttemptMs: 60_000 });
    expect(res.status).toBe(503);
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
