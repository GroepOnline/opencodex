import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  setClientResourceData,
  useKeyedClientResource,
} from "../client-resource";
import { useI18n } from "../i18n/shared";
import {
  readSessionListCache,
  writeSessionListCache,
} from "../session-list-cache";
import { DebugClaudeInboundPanel } from "./debug-claude-inbound-panel";
import { DebugLogViewer } from "./debug-log-viewer";
import { DebugPageHeader, DebugSettingsPanel } from "./debug-settings-panel";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/primitives/empty";
import { Spinner } from "../components/primitives/spinner";
import {
  DEBUG_STREAMS,
  type DebugLogEntry,
  type DebugSettings,
  type LogStream,
  isStreamEnabled,
} from "./debug-shared";

function debugSettingsKey(apiBase: string): string {
  return `debug-settings:${apiBase}`;
}

function isDebugLogEntry(value: unknown): value is DebugLogEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "seq" in value &&
    typeof value.seq === "number" &&
    "at" in value &&
    typeof value.at === "number" &&
    "line" in value &&
    typeof value.line === "string"
  );
}

function DebugResourceLoadState({
  loading,
  loadingLabel,
  errorLabel,
  onRetry,
}: {
  loading: boolean;
  loadingLabel: string;
  errorLabel: string;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  if (loading) {
    return (
      <Empty role="status">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>{loadingLabel}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Empty role="alert">
      <EmptyHeader>
        <EmptyTitle>{errorLabel}</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onRetry}
        >
          {t("common.retry")}
        </button>
      </EmptyContent>
    </Empty>
  );
}

function DebugRefreshError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="row" role="alert">
      <p className="err">{message}</p>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={retrying}
        onClick={onRetry}
      >
        {t("common.retry")}
      </button>
    </div>
  );
}

export default function Debug({
  apiBase,
  embedded,
  active = true,
}: {
  apiBase: string;
  embedded?: boolean;
  active?: boolean;
}) {
  const { t } = useI18n();
  const settingsCacheKey = `ocx.debug.settings.v1:${apiBase}`;
  const cachedSettings = readSessionListCache<DebugSettings>(settingsCacheKey);
  const [debugBusy, setDebugBusy] = useState(false);
  const [stream, setStream] = useState<LogStream>("provider");
  const [entries, setEntries] = useState<
    import("./debug-shared").DebugLogEntry[]
  >([]);
  const [follow, setFollow] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [logState, setLogState] = useState<{
    identity: string;
    status: "loading" | "ready" | "error" | "refresh-error";
  } | null>(null);
  const afterRef = useRef(0);
  const hasLoadedLogsRef = useRef(false);
  const logRequestRef = useRef<AbortController | null>(null);
  const mutationGenerationRef = useRef(0);
  const logGenerationRef = useRef(0);
  const mutationQueueRef = useRef<Promise<void> | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Only reset the log viewer when the active stream identity changes — not when
  // unrelated debug flags toggle (those used to rebuild fetchLogs and storm GETs).
  const streamIdentityRef = useRef<string | null>(null);

  const debugPoll = useKeyedClientResource(
    debugSettingsKey(apiBase),
    [apiBase],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/debug`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as DebugSettings;
      writeSessionListCache(settingsCacheKey, next);
      return next;
    },
    { pollMs: 2000, enabled: active },
  );
  const debug = debugPoll.data ?? cachedSettings ?? null;
  const hasDebugSettings = debug !== null;

  const claudePoll = useKeyedClientResource(
    `debug-claude-inbound:${apiBase}`,
    [apiBase, debug?.claude],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/claude/inbound-debug`, {
        signal,
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        entries?: import("./debug-shared").ClaudeInboundEntry[];
      };
      if (!Array.isArray(data.entries))
        throw new Error("Invalid Claude inbound response");
      return data.entries;
    },
    { pollMs: 2000, enabled: active && !!debug?.claude },
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- known useVirtualizer limitation
  const lineVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 20,
    overscan: 30,
    getItemKey: (index) => entries[index]!.seq,
  });

  const streamIsOn = useCallback(
    (candidate: LogStream): boolean => isStreamEnabled(debug, candidate),
    [debug],
  );

  useEffect(() => {
    if (!debug || streamIsOn(stream)) return;
    const next = DEBUG_STREAMS.find(streamIsOn);
    if (!next) return;
    const timeout = window.setTimeout(() => setStream(next), 0);
    return () => window.clearTimeout(timeout);
  }, [debug, stream, streamIsOn]);

  const streamEnabled = streamIsOn(stream);
  const logsPath =
    stream === "provider"
      ? `${apiBase}/api/debug/logs`
      : stream === "usage"
        ? `${apiBase}/api/debug/usage-logs`
        : `${apiBase}/api/debug/injection-logs`;

  const streamIdentity = `${apiBase}:${stream}:${streamEnabled}`;
  const logStatus =
    logState?.identity === streamIdentity ? logState.status : "loading";

  const fetchLogs = useCallback(
    async (initial: boolean) => {
      // A slow response must be allowed to finish instead of being superseded on every tick.
      if (!active || logRequestRef.current) return;
      const generation = ++logGenerationRef.current;
      if (!streamEnabled) {
        if (generation === logGenerationRef.current) {
          setEntries([]);
          afterRef.current = 0;
          hasLoadedLogsRef.current = false;
          setLogState({ identity: streamIdentity, status: "ready" });
          setRefreshing(false);
        }
        return;
      }
      const controller = new AbortController();
      logRequestRef.current = controller;
      const { signal } = controller;
      const firstLoad = !hasLoadedLogsRef.current;
      if (firstLoad)
        setLogState({ identity: streamIdentity, status: "loading" });
      setRefreshing(true);
      try {
        const params = new URLSearchParams({ limit: "500" });
        if (!initial && afterRef.current > 0)
          params.set("after", String(afterRef.current));
        const res = await fetch(`${logsPath}?${params}`, { signal });
        if (!res.ok) throw new Error(String(res.status));
        if (signal.aborted || generation !== logGenerationRef.current) return;
        const next: unknown = await res.json();
        if (!Array.isArray(next) || !next.every(isDebugLogEntry)) {
          throw new Error("Invalid debug log response");
        }
        if (signal.aborted || generation !== logGenerationRef.current) return;
        if (initial || next.length > 0) {
          setEntries((prev) =>
            (initial ? next : [...prev, ...next]).slice(-2000),
          );
          afterRef.current = next.at(-1)?.seq ?? 0;
        }
        hasLoadedLogsRef.current = true;
        setLogState({ identity: streamIdentity, status: "ready" });
      } catch {
        if (!signal.aborted && generation === logGenerationRef.current) {
          setLogState({
            identity: streamIdentity,
            status: firstLoad ? "error" : "refresh-error",
          });
        }
      } finally {
        if (generation === logGenerationRef.current) {
          setRefreshing(false);
          logRequestRef.current = null;
        }
      }
    },
    [active, logsPath, streamEnabled, streamIdentity],
  );

  useEffect(() => {
    if (!active || !hasDebugSettings) return;
    const identity = `${apiBase}:${stream}:${streamEnabled}`;
    const changed = streamIdentityRef.current !== identity;
    streamIdentityRef.current = identity;
    const timeout = window.setTimeout(() => {
      setRefreshing(false);
      if (!changed && hasLoadedLogsRef.current) return;
      afterRef.current = 0;
      hasLoadedLogsRef.current = false;
      if (changed) setEntries([]);
      void fetchLogs(true);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      logGenerationRef.current += 1;
      logRequestRef.current?.abort();
      logRequestRef.current = null;
    };
    // Intentionally omit fetchLogs — identity gate prevents switch storms.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stream identity only
  }, [active, apiBase, hasDebugSettings, stream, streamEnabled]);

  const pollLogs = useEffectEvent((initial: boolean) => {
    void fetchLogs(initial);
  });

  useEffect(() => {
    if (!active || !follow || !streamEnabled) return;
    const interval = setInterval(() => pollLogs(false), 1000);
    return () => clearInterval(interval);
  }, [active, follow, streamEnabled]);

  useEffect(() => {
    if (follow && entries.length > 0) {
      lineVirtualizer.scrollToIndex(entries.length - 1, { align: "end" });
    }
  }, [entries, follow, lineVirtualizer]);

  const runDebugMutation = async (body: Record<string, unknown>) => {
    const generation = ++mutationGenerationRef.current;
    setDebugBusy(true);
    // Serialize PUTs so server writes follow user-action order. Latest-wins
    // response filtering alone cannot prevent out-of-order server state.
    const run = async () => {
      try {
        const res = await fetch(`${apiBase}/api/debug`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return;
        const next = (await res.json()) as DebugSettings;
        if (generation !== mutationGenerationRef.current) return;
        writeSessionListCache(settingsCacheKey, next);
        setClientResourceData(debugSettingsKey(apiBase), next);
      } catch {
        /* ignore */
      }
    };
    const previous = mutationQueueRef.current ?? Promise.resolve();
    const queued = previous.then(run, run);
    mutationQueueRef.current = queued.then(
      () => undefined,
      () => undefined,
    );
    try {
      await queued;
    } finally {
      if (generation === mutationGenerationRef.current) setDebugBusy(false);
    }
  };

  const setDebugFlag = async (
    flag: "debug" | "usage" | "injection" | "claude",
    enabled: boolean,
  ) => {
    await runDebugMutation({ [flag]: enabled });
  };

  const resetDebug = async () => {
    await runDebugMutation({ reset: true });
  };

  return (
    <div className={embedded ? "debug-page" : "debug-page ocx-page-root"}>
      <DebugPageHeader
        embedded={embedded}
        refreshing={refreshing}
        streamEnabled={streamEnabled}
        follow={follow}
        onRefresh={() => void fetchLogs(true)}
        onFollowChange={setFollow}
      />

      {!debug ? (
        <DebugResourceLoadState
          loading={debugPoll.loading || debugPoll.error === undefined}
          loadingLabel={t("debug.loading")}
          errorLabel={t("debug.settingsLoadError")}
          onRetry={() => debugPoll.refresh()}
        />
      ) : (
        <>
          {debugPoll.error !== undefined && (
            <DebugRefreshError
              message={t("debug.settingsRefreshError")}
              retrying={debugPoll.loading}
              onRetry={() => debugPoll.refresh({ forceLoading: true })}
            />
          )}
          <DebugSettingsPanel
            debug={debug}
            debugBusy={debugBusy}
            stream={stream}
            onSetFlag={(flag, enabled) => {
              void setDebugFlag(flag, enabled);
            }}
            onReset={() => {
              void resetDebug();
            }}
            onStreamChange={setStream}
          />
        </>
      )}

      {debug?.claude && (
        <DebugClaudeInboundPanel
          entries={claudePoll.data}
          feedback={
            claudePoll.data === undefined ? (
              <DebugResourceLoadState
                loading={claudePoll.loading || claudePoll.error === undefined}
                loadingLabel={t("debug.claudeInbound.loading")}
                errorLabel={t("debug.claudeInbound.loadError")}
                onRetry={() => claudePoll.refresh()}
              />
            ) : claudePoll.error !== undefined ? (
              <DebugRefreshError
                message={t("debug.claudeInbound.refreshError")}
                retrying={claudePoll.loading}
                onRetry={() => claudePoll.refresh({ forceLoading: true })}
              />
            ) : undefined
          }
        />
      )}

      {debug &&
      streamEnabled &&
      (logStatus === "loading" || logStatus === "error") ? (
        <DebugResourceLoadState
          loading={logStatus === "loading"}
          loadingLabel={t("debug.logsLoading")}
          errorLabel={t("debug.logsLoadError")}
          onRetry={() => void fetchLogs(true)}
        />
      ) : (
        <>
          {debug && streamEnabled && logStatus === "refresh-error" && (
            <DebugRefreshError
              message={t("debug.logsRefreshError")}
              retrying={refreshing}
              onRetry={() => void fetchLogs(false)}
            />
          )}
          <DebugLogViewer
            debug={!!debug}
            stream={stream}
            streamEnabled={streamEnabled}
            entries={entries}
            scrollContainerRef={scrollContainerRef}
            lineVirtualizer={lineVirtualizer}
          />
        </>
      )}
    </div>
  );
}
