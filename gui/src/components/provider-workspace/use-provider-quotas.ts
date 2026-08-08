/**
 * use-provider-quotas.ts — per-provider quota fetch controller (Leveranciers fan-out).
 *
 * Contract (design-system opencodex brief, hard requirement):
 * - ONE fetch per provider, fully independent: a slow provider never blocks another card.
 * - Per-card state: loading / ready (VERS · HH:MM) / stale (>5 min: VEROUDERD) /
 *   error (cause + [Opnieuw proberen]) / unsupported (no quota API: card hides quota).
 * - Global refresh = fire every provider fetch in parallel, never one merged call.
 * - Race protection: a newer request for the same provider supersedes; stale responses
 *   are dropped. Concurrent fetches per provider are deduped (StrictMode-safe).
 * - Errors auto-retry with bounded backoff (10s, 30s, 60s, then stop); the next-retry
 *   timestamp is exposed so the card can show "Opnieuw om HH:MM".
 * - Account actions refresh only their own provider (via refresh(name)).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonIfOk } from "../../fetch-json";
import { readSessionListCache, writeSessionListCache } from "../../session-list-cache";
import type { ProviderQuotaReportView } from "../../provider-workspace/report";

export type QuotaCardStatus = "loading" | "ready" | "stale" | "error" | "unsupported";

export interface QuotaCardState {
  status: QuotaCardStatus;
  report?: ProviderQuotaReportView;
  /** Last successful update (epoch ms) — drives VERS · HH:MM and the 5-minute stale flip. */
  freshAt?: number;
  /** Server discriminator or transport failure marker ("quota-probe-failed" | "http" | "network"). */
  error?: string;
  /** Completed failed attempts; backoff stops after BACKOFF_MS.length. */
  attempt: number;
  /** Next scheduled auto-retry (epoch ms); undefined once backoff stops. */
  nextRetryAt?: number;
}

export const QUOTA_STALE_AFTER_MS = 5 * 60_000;
export const QUOTA_BACKOFF_MS = [10_000, 30_000, 60_000] as const;

interface SliceResponse {
  generatedAt?: number;
  reports?: Array<ProviderQuotaReportView & { provider?: string }>;
  unsupported?: boolean;
  error?: string;
}

function seedCards(
  cacheKey: string,
  names: string[],
  staleAfterMs: number,
): Record<string, QuotaCardState> {
  const cached = readSessionListCache<Record<string, ProviderQuotaReportView & { freshAt?: number }>>(cacheKey) ?? {};
  const now = Date.now();
  return Object.fromEntries(names.map(name => {
    const row = cached[name];
    if (row?.updatedAt) {
      const freshAt = typeof row.freshAt === "number" ? row.freshAt : row.updatedAt;
      return [name, { status: now - freshAt > staleAfterMs ? "stale" : "ready", report: row, freshAt, attempt: 0 } satisfies QuotaCardState];
    }
    return [name, { status: "loading", attempt: 0 } satisfies QuotaCardState];
  }));
}

export function useProviderQuotas({
  apiBase,
  providers,
  cacheKey,
  staleAfterMs = QUOTA_STALE_AFTER_MS,
  backoffMs = QUOTA_BACKOFF_MS,
}: {
  apiBase: string;
  /** Provider names to track (caller memoizes; identity drives re-seed). */
  providers: string[];
  /** Session seed key (no secrets — quota rows only). */
  cacheKey: string;
  /** Ready → stale bound. Injectable so tests run with short real timers (no fake clock). */
  staleAfterMs?: number;
  /** Auto-retry backoff ladder. Injectable so tests run with short real timers. */
  backoffMs?: readonly number[];
}) {
  const providersKey = providers.join("\n");
  // Timer profile is mount-stable (defaults or test-injected); captured once via
  // useRef's initializer (no ref mutation during render), read from callbacks/effects.
  const timerProfileRef = useRef({ staleAfterMs, backoffMs });
  const [cards, setCards] = useState<Record<string, QuotaCardState>>(() => seedCards(cacheKey, providers, staleAfterMs));
  const inflightRef = useRef(new Map<string, number>());
  const retryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const nextIdRef = useRef(1);
  const mountedRef = useRef(true);

  const setCard = useCallback((name: string, next: QuotaCardState | ((prev: QuotaCardState) => QuotaCardState)) => {
    if (!mountedRef.current) return;
    setCards(prev => ({
      ...prev,
      [name]: typeof next === "function" ? next(prev[name] ?? { status: "loading", attempt: 0 }) : next,
    }));
  }, []);

  const persistReport = useCallback((name: string, report: ProviderQuotaReportView, freshAt: number) => {
    try {
      const cached = readSessionListCache<Record<string, ProviderQuotaReportView & { freshAt?: number }>>(cacheKey) ?? {};
      writeSessionListCache(cacheKey, { ...cached, [name]: { ...report, freshAt } });
    } catch { /* storage full / private mode — cache is a nicety */ }
  }, [cacheKey]);

  // Retry queue: timers only record intent (no recursive fetchOne self-reference).
  // The retryTick effect below fires the queued attempts through fetchOne.
  const retryQueueRef = useRef(new Map<string, number>());
  const [retryTick, setRetryTick] = useState(0);

  const cancelRetry = useCallback((name: string) => {
    const timer = retryTimersRef.current.get(name);
    if (timer) clearTimeout(timer);
    retryTimersRef.current.delete(name);
    retryQueueRef.current.delete(name);
  }, []);

  const scheduleRetry = useCallback((name: string, nextAttempt: number, delayMs: number) => {
    const prev = retryTimersRef.current.get(name);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      // A forced refresh or a successful probe may have invalidated this timer.
      if (retryTimersRef.current.get(name) !== timer) return;
      retryTimersRef.current.delete(name);
      retryQueueRef.current.set(name, nextAttempt);
      setRetryTick(t => t + 1);
    }, delayMs);
    retryTimersRef.current.set(name, timer);
  }, []);

  const fetchOne = useCallback(async (name: string, opts: { force?: boolean; attempt?: number } = {}) => {
    const attempt = opts.attempt ?? 0;
    // Dedupe: an in-flight non-force request for this provider already covers this one
    // (StrictMode double-effects, timer/refresh overlap). Force always supersedes —
    // that is the only way out of a hung request.
    if (!opts.force && inflightRef.current.has(name)) return;
    // Race protection: this request id supersedes any older in-flight request for the
    // same provider; stale responses are dropped on arrival.
    const id = nextIdRef.current++;
    inflightRef.current.set(name, id);
    const isCurrent = () => inflightRef.current.get(name) === id;

    const fail = (cause: string) => {
      if (!isCurrent()) return;
      inflightRef.current.delete(name); // the retry timer starts a fresh request
      const { backoffMs: ladder } = timerProfileRef.current;
      const willRetry = attempt < ladder.length;
      const nextRetryAt = willRetry ? Date.now() + ladder[attempt] : undefined;
      setCard(name, prev => ({
        status: "error",
        error: cause,
        report: prev.report,
        freshAt: prev.freshAt,
        attempt: attempt + 1,
        nextRetryAt,
      }));
      if (willRetry) scheduleRetry(name, attempt + 1, ladder[attempt]);
    };

    setCard(name, prev => (prev.report ? prev : { status: "loading", attempt }));
    try {
      const res = await fetch(
        `${apiBase}/api/provider-quotas?provider=${encodeURIComponent(name)}${opts.force ? "&refresh=1" : ""}`,
      );
      const data = res.ok ? await readJsonIfOk<SliceResponse>(res) : null;
      if (!isCurrent()) return;
      if (!data) return fail(res.ok ? "parse" : "http");
      if (data.unsupported) {
        inflightRef.current.delete(name);
        cancelRetry(name);
        setCard(name, { status: "unsupported", attempt: 0 });
        return;
      }
      const report = data.reports?.[0];
      if (report) {
        inflightRef.current.delete(name);
        cancelRetry(name);
        const now = Date.now();
        const view: ProviderQuotaReportView = {
          label: report.label ?? name,
          ...(report.source !== undefined ? { source: report.source } : {}),
          quota: report.quota,
          updatedAt: report.updatedAt ?? now,
        };
        setCard(name, { status: "ready", report: view, freshAt: now, attempt: 0 });
        persistReport(name, view, now);
        return;
      }
      fail(data.error ?? "quota-probe-failed");
    } catch {
      if (isCurrent()) fail("network");
    }
  }, [apiBase, cancelRetry, persistReport, scheduleRetry, setCard]);

  // Fire queued retry attempts (scheduled by backoff timers).
  useEffect(() => {
    if (retryTick === 0) return;
    for (const [name, attempt] of retryQueueRef.current) {
      retryQueueRef.current.delete(name);
      void fetchOne(name, { attempt });
    }
  }, [retryTick, fetchOne]);

  /** Refresh one provider (force = bypass server cache) or every provider in parallel. */
  const refresh = useCallback((name?: string, opts?: { force?: boolean }) => {
    const force = opts?.force ?? (name ? true : false);
    if (name) {
      if (force) cancelRetry(name);
      return void fetchOne(name, { force, attempt: 0 });
    }
    for (const p of providers) {
      if (force) cancelRetry(p);
      void fetchOne(p, { force, attempt: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- providersKey is the identity
  }, [cancelRetry, fetchOne, providersKey]);

  // Initial fan-out when the provider set changes. No sync re-seed here: the useState
  // initializer paints the session seed on mount, and fetchOne's setCard creates
  // loading cards for providers that are new to the set. (Zombie cards for removed
  // providers are ignored by the shell, which maps over current items.)
  useEffect(() => {
    for (const p of providers) void fetchOne(p, { attempt: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- providersKey is the identity
  }, [cacheKey, providersKey]);

  // Stale ticker: flip ready → stale once freshAt passes the stale bound.
  // Ticks at min(15s, staleAfterMs/2) so an injected short bound still flips promptly.
  useEffect(() => {
    const staleAfterMs = timerProfileRef.current.staleAfterMs;
    const timer = setInterval(() => {
      if (!mountedRef.current) return;
      const now = Date.now();
      setCards(prev => {
        let changed = false;
        const next = { ...prev };
        for (const [name, card] of Object.entries(next)) {
          if (card.status === "ready" && card.freshAt && now - card.freshAt > staleAfterMs) {
            next[name] = { ...card, status: "stale" };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, Math.min(15_000, staleAfterMs / 2));
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const timers = retryTimersRef.current;
    return () => {
      mountedRef.current = false;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  return { cards, refresh };
}
