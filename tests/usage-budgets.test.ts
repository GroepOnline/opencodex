import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetTracker } from "../src/usage/budgets";

/**
 * A long-lived tracker only loads persisted state once, at construction. These
 * cover the in-process rollover: a proxy left running past local midnight (or
 * past the Monday boundary) must not keep counting into — or reporting — the
 * previous window.
 */
describe("BudgetTracker window rollover", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env["OPENCODEX_HOME"];
    home = mkdtempSync(join(tmpdir(), "ocx-budget-"));
    process.env["OPENCODEX_HOME"] = home;
  });

  afterEach(() => {
    setSystemTime();
    if (previousHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** Wednesday 12:00 local — mid-day, mid-week, so both boundaries are reachable. */
  const wednesday = new Date(2025, 0, 8, 12, 0, 0, 0);

  function newTracker(): BudgetTracker {
    setSystemTime(wednesday);
    const tracker = new BudgetTracker({ tokenDaily: 1_000, tokenWeekly: 5_000 });
    tracker.recordUsage("openai", "gpt-4o", { inputTokens: 100, outputTokens: 20 });
    expect(tracker.getUsageSummary().todayTokens).toBe(120);
    return tracker;
  }

  it("clears the daily counters after local midnight while keeping the week", () => {
    const tracker = newTracker();
    const costBefore = tracker.getUsageSummary().todayCostEur;
    expect(costBefore).toBeGreaterThan(0);

    setSystemTime(new Date(2025, 0, 9, 0, 30, 0, 0)); // Thursday, same week

    const summary = tracker.getUsageSummary();
    expect(summary.todayTokens).toBe(0);
    expect(summary.todayCostEur).toBe(0);
    expect(summary.weekTokens).toBe(120);

    tracker.recordUsage("openai", "gpt-4o", { inputTokens: 5, outputTokens: 5 });
    const after = tracker.getUsageSummary();
    expect(after.todayTokens).toBe(10);
    expect(after.weekTokens).toBe(130);
    tracker.shutdown();
  });

  it("clears the weekly counter once the Monday boundary passes", () => {
    const tracker = newTracker();

    setSystemTime(new Date(2025, 0, 13, 9, 0, 0, 0)); // following Monday

    const summary = tracker.getUsageSummary();
    expect(summary.todayTokens).toBe(0);
    expect(summary.weekTokens).toBe(0);
    tracker.shutdown();
  });

  it("re-arms daily alerts in the new window instead of staying latched", () => {
    setSystemTime(wednesday);
    const tracker = new BudgetTracker({ tokenDaily: 100 });
    expect(tracker.recordUsage("openai", "gpt-4o", { inputTokens: 100, outputTokens: 50 })).toHaveLength(1);
    // Same window: deduped.
    expect(tracker.recordUsage("openai", "gpt-4o", { inputTokens: 100, outputTokens: 50 })).toHaveLength(0);

    setSystemTime(new Date(2025, 0, 9, 12, 0, 0, 0));
    expect(tracker.getUsageSummary().todayTokens).toBe(0);
    const alerts = tracker.recordUsage("openai", "gpt-4o", { inputTokens: 100, outputTokens: 50 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.actual).toBe(150);
    tracker.shutdown();
  });
});
