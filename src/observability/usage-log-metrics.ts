/**
 * Runtime-metrics bridge for usage appends.
 *
 * Metrics observe the append boundary in src/usage/log.ts: appendUsageEntry emits
 * a bounded structural observation synchronously after each successful append.
 * Scrapes serve the in-memory registry only and perform zero usage-log filesystem
 * I/O, so no change to the file on disk can replay or corrupt counters.
 *
 * Existing usage.jsonl history is never replayed; a process restart starts
 * counters at zero and only rows appended by this process are counted.
 */
import { subscribeUsageAppends, type UsageAppendObservation } from "../usage/log";
import { runtimeMetrics } from "./metrics";

let unsubscribeUsageAppends: (() => void) | null = null;

function recordUsageAppend(observation: UsageAppendObservation): void {
  // The observation carries only bounded surface/status/duration/TTFT/terminal
  // enums and scalar token counts; provider, model, account, request,
  // conversation, and error values never reach the registry.
  runtimeMetrics.recordRequest(observation);
}

/**
 * Idempotent process-wide registration. Server startup calls this before the
 * listener accepts requests; repeated startServer(0) calls (tests, restarts)
 * share the single registration and cannot double-count appends.
 */
export function ensureUsageLogMetricsObserver(): void {
  if (unsubscribeUsageAppends) return;
  unsubscribeUsageAppends = subscribeUsageAppends(recordUsageAppend);
}

/** Test-only dispose so suites can isolate registrations; production never calls this. */
export function resetUsageLogMetricsObserverForTests(): void {
  unsubscribeUsageAppends?.();
  unsubscribeUsageAppends = null;
}
