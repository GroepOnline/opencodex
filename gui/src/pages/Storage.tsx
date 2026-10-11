import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/shared";
import { IconRefresh, IconHardDrive, IconAlert } from "../icons";
import StorageWorkspace, {
  type StorageReport,
} from "../components/storage-workspace/StorageWorkspace";
import {
  readSessionListCache,
  writeSessionListCache,
} from "../session-list-cache";
import { PageHeader, PageSubtitle } from "../components/primitives/page-header";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/primitives/empty";
import { Timestamp } from "../components/primitives/timestamp";
import { Spinner } from "../components/primitives/spinner";
import type { TrashEntry } from "../components/storage-workspace/storage-types";
import { StorageCleanupCard } from "../components/storage-workspace/storage-cleanup-card";

export default function Storage({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const storageCacheKey = `ocx.storage.report.v1:${apiBase}`;
  const cachedReport = readSessionListCache<StorageReport>(storageCacheKey);
  const [data, setData] = useState<StorageReport | null>(() => cachedReport);
  const [loading, setLoading] = useState(() => !cachedReport);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [trashReloadToken, setTrashReloadToken] = useState(0);
  // Stamp trash awareness with apiBase so a base change invalidates without an effect.
  const [trashInfo, setTrashInfo] = useState({
    apiBase,
    settled: false,
    hasEntries: false,
  });
  const loadGenerationRef = useRef(0);
  const hasReportRef = useRef(Boolean(cachedReport));

  const fetchStorage = useCallback(
    async (signal?: AbortSignal) => {
      const generation = ++loadGenerationRef.current;
      // Keep Refresh disabled for soft revalidation too (cached report already painted).
      setLoading(true);
      try {
        const res = await fetch(`${apiBase}/api/storage`, { signal });
        if (!res.ok) throw new Error("fetch failed");
        const json = (await res.json()) as StorageReport;
        if (signal?.aborted || generation !== loadGenerationRef.current) return;
        setData(json);
        hasReportRef.current = true;
        writeSessionListCache(storageCacheKey, json);
        return json;
      } catch {
        if (signal?.aborted || generation !== loadGenerationRef.current) return;
        if (!hasReportRef.current) setData(null);
        return null;
      } finally {
        if (generation === loadGenerationRef.current) setLoading(false);
      }
    },
    [apiBase, storageCacheKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void fetchStorage(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      loadGenerationRef.current += 1;
      controller.abort();
    };
  }, [fetchStorage]);

  const refreshAll = useCallback(async () => {
    setScanStatus(null);
    const report = await fetchStorage();
    setTrashReloadToken((n) => n + 1);
    setScanStatus(
      report && report.error === undefined
        ? t("storage.rescanned")
        : t("storage.error"),
    );
  }, [fetchStorage, t]);

  const onTrashEntriesChange = useCallback(
    (entries: TrashEntry[]) => {
      setTrashInfo({ apiBase, settled: true, hasEntries: entries.length > 0 });
    },
    [apiBase],
  );

  const trashSettled = trashInfo.apiBase === apiBase && trashInfo.settled;
  const trashHasEntries = trashInfo.apiBase === apiBase && trashInfo.hasEntries;
  const failed = !loading && (!data || data.error !== undefined);
  const empty =
    !loading &&
    !failed &&
    data!.total.fileCount === 0 &&
    trashSettled &&
    !trashHasEntries;
  const archivedCount =
    data?.buckets.find((b) => b.key === "archived_sessions")?.fileCount ?? 0;
  const showBody = Boolean(data) && !failed;
  // While storage is empty, keep the trash panel mounted until it reports so we
  // do not flash the empty state over a non-empty quarantine.
  const showTrashWhileSettling =
    showBody && (data!.total.fileCount > 0 || !trashSettled || trashHasEntries);

  return (
    <div className="ocx-page-root">
      <PageHeader
        titleId="storage-page-title"
        title={t("storage.title")}
        actionsClassName="storage-page-head-actions"
        actions={
          <>
            <span
              className="storage-page-head-feedback"
              role="status"
              aria-live="polite"
            >
              {scanStatus ?? ""}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={loading}
              onClick={() => void refreshAll()}
            >
              <IconRefresh /> {t("storage.refresh")}
            </button>
          </>
        }
      />
      <PageSubtitle>{t("storage.subtitle")}</PageSubtitle>
      {data && data.error === undefined && (
        <p className="storage-page-meta">
          <code className="storage-page-meta__home" title={data.codexHome}>
            {data.codexHome}
          </code>
          <span className="storage-page-meta__sep" aria-hidden="true">
            ·
          </span>
          <span>
            {t("storage.snapshot.lastScan")}:{" "}
            <Timestamp
              value={data.generatedAt}
              locale={locale}
              options={{ dateStyle: "medium", timeStyle: "short" }}
            />
          </span>
        </p>
      )}

      {loading && !data ? (
        <Empty className="storage-empty-panel">
          <EmptyHeader>
            <EmptyMedia>
              <Spinner />
            </EmptyMedia>
            <EmptyTitle>{t("storage.loading")}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : failed ? (
        <Empty className="storage-empty-panel">
          <EmptyHeader>
            <EmptyMedia>
              <IconAlert size={24} aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{t("storage.error")}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : empty ? (
        <Empty className="storage-empty-panel">
          <EmptyHeader>
            <EmptyMedia>
              <IconHardDrive size={24} aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{t("storage.empty")}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        data &&
        data.total.fileCount > 0 && (
          <StorageWorkspace report={data} locale={locale} />
        )
      )}

      {showBody && (
        <StorageCleanupCard
          apiBase={apiBase}
          locale={locale}
          t={t}
          archivedCount={archivedCount}
          showQuarantine={showTrashWhileSettling}
          trashReloadToken={trashReloadToken}
          onDone={() => void refreshAll()}
          onTrashEntriesChange={onTrashEntriesChange}
        />
      )}
    </div>
  );
}
