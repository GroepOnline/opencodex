import { useCallback, useEffect, useRef, useState } from "react";
import type { TFn } from "../../../i18n/shared";
import { usagePayloadKey, type Range, type UsageResponse, type UsageSurface } from "../model/usage-report";

/** Owns polling, request cancellation and last-good values scoped to one usage query. */
export function useUsageData({ apiBase, range, surface, t }: {
  apiBase: string;
  range: Range;
  surface: UsageSurface;
  t: TFn;
}) {
  const [snapshot, setSnapshot] = useState<{
    key: string;
    data: UsageResponse;
  } | null>(null);
  const data =
    snapshot?.key === usagePayloadKey(apiBase, range, surface)
      ? snapshot.data
      : null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const dataRef = useRef<UsageResponse | null>(null);
  const lastGoodKeyRef = useRef<string | null>(null);

  const fetchUsage = useCallback(
    async (
      nextRange: Range,
      nextSurface: UsageSurface,
      signal: AbortSignal,
    ) => {
      const generation = ++loadGenerationRef.current;
      const requestKey = usagePayloadKey(apiBase, nextRange, nextSurface);
      setLoading(true);
      try {
        const res = await fetch(
          `${apiBase}/api/usage?range=${nextRange}&surface=${nextSurface}`,
          { signal },
        );
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
        const json = (await res.json()) as UsageResponse;
        if (signal.aborted || generation !== loadGenerationRef.current) return;
        lastGoodKeyRef.current = requestKey;
        dataRef.current = json;
        setSnapshot({ key: requestKey, data: json });
        setError(null);
      } catch (cause) {
        // A stale request (range/apiBase changed, or unmount) must not overwrite newer state.
        if (signal.aborted || generation !== loadGenerationRef.current) return;
        // Keep last-good readings only for this API, range and surface.
        if (lastGoodKeyRef.current !== requestKey || !dataRef.current) {
          dataRef.current = null;
          setSnapshot(null);
        }
        const detail = cause instanceof Error ? cause.message : "";
        setError(
          detail ? `${t("usage.loadError")} ${detail}` : t("usage.loadError"),
        );
      } finally {
        // Only the current request may clear loading — a superseded abort must not
        // settle the UI while a newer fetch is still in flight.
        if (generation === loadGenerationRef.current) setLoading(false);
      }
    },
    [apiBase, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    const run = () => {
      void fetchUsage(range, surface, controller.signal);
    };
    const timeout = window.setTimeout(run, 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      run();
    }, 30_000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      // Invalidate before abort so a superseded request's finally cannot clear
      // loading in the gap before the deferred replacement increments generation.
      loadGenerationRef.current += 1;
      controller.abort();
    };
  }, [fetchUsage, range, surface]);

  const retry = useCallback(() => {
    void fetchUsage(range, surface, new AbortController().signal);
  }, [fetchUsage, range, surface]);
  return { data, loading, error, retry };
}
