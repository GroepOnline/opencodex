/**
 * useProviderQuotas — single owner of /api/provider-quotas state for the GUI.
 *
 * Per-provider refresh (`refreshProvider`) hits `?provider=<name>` so one
 * provider's probe never touches other upstreams. Rows merge by provider and
 * a stale response can never overwrite a newer row (generation-guarded).
 * Concurrent refreshes of the same request (URL) join the in-flight request;
 * a forced `refreshAll(true)` (`?refresh=1`) never joins a non-forced one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderQuotaReportView } from "./provider-workspace/report";

interface WireReport {
  provider: string;
  label?: string;
  source?: string;
  updatedAt?: number;
  quota?: unknown;
}

export interface ProviderQuotasApi {
  reports: Record<string, ProviderQuotaReportView>;
  /** Providers with a refresh in flight (per-provider spinners; never a global one). */
  refreshing: Record<string, boolean>;
  /** Providers whose last refresh failed (last-good data stays visible). */
  failed: Record<string, boolean>;
  /** Force-probe one provider's upstream. Resolves true on success. */
  refreshProvider: (name: string) => Promise<boolean>;
  /** Aggregate load; force=true re-probes every provider (config-level changes only). */
  refreshAll: (force?: boolean) => Promise<boolean>;
}

const ALL = "*";

export function useProviderQuotas(apiBase: string): ProviderQuotasApi {
  const [reports, setReports] = useState<Record<string, ProviderQuotaReportView>>({});
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const aliveRef = useRef(true);
  const generationRef = useRef<Record<string, number>>({});
  const inflightRef = useRef<Map<string, Promise<boolean>>>(new Map());

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const mergeReports = useCallback((rows: WireReport[]) => {
    if (!aliveRef.current || rows.length === 0) return;
    setReports(prev => {
      const next = { ...prev };
      for (const row of rows) {
        if (!row?.provider) continue;
        const updatedAt = typeof row.updatedAt === "number" ? row.updatedAt : Date.now();
        const existing = next[row.provider];
        // Race guard: a slower response must not roll back a newer row.
        if (existing?.updatedAt !== undefined && existing.updatedAt > updatedAt) continue;
        next[row.provider] = { label: row.label, source: row.source, updatedAt, quota: row.quota };
      }
      return next;
    });
  }, []);

  const runScoped = useCallback((scope: string, url: string): Promise<boolean> => {
    // Dedupe by URL, not scope: a forced refresh (`?refresh=1`) and a plain one both
    // target scope ALL but carry different URLs, so the forced call must not join
    // (and lose its re-probe intent to) an in-flight non-forced call.
    const joinable = inflightRef.current.get(url);
    if (joinable) return joinable;

    const generation = (generationRef.current[scope] ?? 0) + 1;
    generationRef.current[scope] = generation;
    const isCurrent = () => aliveRef.current && generationRef.current[scope] === generation;

    if (scope !== ALL) setRefreshing(prev => ({ ...prev, [scope]: true }));

    const promise = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json() as { reports?: WireReport[] };
        if (!isCurrent()) return true;
        mergeReports(data.reports ?? []);
        if (scope === ALL) {
          setFailed({});
        } else {
          setFailed(prev => ({ ...prev, [scope]: false }));
        }
        return true;
      } catch {
        if (isCurrent() && scope !== ALL) setFailed(prev => ({ ...prev, [scope]: true }));
        return false;
      } finally {
        inflightRef.current.delete(url);
        if (isCurrent() && scope !== ALL) setRefreshing(prev => ({ ...prev, [scope]: false }));
      }
    })();

    inflightRef.current.set(url, promise);
    return promise;
  }, [mergeReports]);

  const refreshProvider = useCallback(
    (name: string) => runScoped(name, `${apiBase}/api/provider-quotas?provider=${encodeURIComponent(name)}`),
    [apiBase, runScoped],
  );

  const refreshAll = useCallback(
    (force = false) => runScoped(ALL, `${apiBase}/api/provider-quotas${force ? "?refresh=1" : ""}`),
    [apiBase, runScoped],
  );

  return { reports, refreshing, failed, refreshProvider, refreshAll };
}
