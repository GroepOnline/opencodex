import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale, TFn } from "../../i18n/shared";
import { formatBytes } from "../../format-bytes";
import { localizedCatch } from "./storage-cleanup-policy";
import type { RestoreResult, TrashEntry, TrashList } from "./storage-types";
import { StorageConfirmActions, StorageConfirmDialog } from "./storage-confirm";

export function QuarantineTrashPanel({
  apiBase,
  locale,
  t,
  onDone,
  reloadToken,
  onEntriesChange,
}: {
  apiBase: string;
  locale: Locale;
  t: TFn;
  onDone: () => void;
  reloadToken: number;
  onEntriesChange?: (entries: TrashEntry[]) => void;
}) {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmEntry, setConfirmEntry] = useState<TrashEntry | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const closeConfirm = useCallback(() => setConfirmEntry(null), []);

  useEffect(() => {
    if (!confirmEntry) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: WindowEventMap["keydown"]) => {
      if (e.key === "Escape" && !busyRef.current) closeConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocusRef.current?.focus();
    };
  }, [confirmEntry, closeConfirm]);

  const loadTrash = useCallback(
    async (signal?: AbortSignal) => {
      const generation = ++loadGenerationRef.current;
      setLoading(true);
      try {
        const res = await fetch(`${apiBase}/api/storage/trash`, { signal });
        if (!res.ok) {
          if (signal?.aborted || generation !== loadGenerationRef.current)
            return;
          throw new Error(t("storage.trash.listFailed"));
        }
        const json = (await res.json()) as TrashList;
        if (signal?.aborted || generation !== loadGenerationRef.current) return;
        const next = Array.isArray(json.entries) ? json.entries : [];
        setEntries(next);
        onEntriesChange?.(next);
        setError(null);
      } catch (e) {
        if (signal?.aborted || generation !== loadGenerationRef.current) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setEntries([]);
        onEntriesChange?.([]);
        setError(localizedCatch(e, t("storage.trash.listFailed")));
      } finally {
        if (generation === loadGenerationRef.current) setLoading(false);
      }
    },
    [apiBase, t, onEntriesChange],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void loadTrash(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      loadGenerationRef.current += 1;
      controller.abort();
    };
  }, [loadTrash, reloadToken]);

  const mapRestoreError = (code: string | undefined, fallback?: string) => {
    switch (code) {
      case "codex_busy":
        return t("storage.trash.err.codex_busy");
      case "invalid_trash":
        return t("storage.trash.err.invalid_trash");
      case "missing_trash":
        return t("storage.trash.err.missing_trash");
      case "dest_exists":
        return t("storage.trash.err.dest_exists");
      case "fs_failed":
        return t("storage.trash.err.fs_failed");
      case "db_reconcile_failed":
        return t("storage.trash.err.db_reconcile_failed");
      case "storage_mutation_busy":
        return t("storage.trash.err.storage_mutation_busy");
      case "restore_failed":
        return t("storage.trash.err.restore_failed");
      case "restore_worker_timeout":
        return t("storage.trash.err.restore_worker_timeout");
      case "restore_worker_aborted":
        return t("storage.trash.err.restore_worker_aborted");
      case "restore_worker_failed":
        return fallback ?? t("storage.trash.err.restore_worker_failed");
      default:
        return fallback ?? t("storage.trash.restoreFailed");
    }
  };

  const runRestore = async () => {
    if (!confirmEntry) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/trash/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: confirmEntry.id }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as RestoreResult;
        throw new Error(mapRestoreError(json.error, json.message));
      }
      const json = (await res.json()) as RestoreResult;
      if (!json.ok) {
        throw new Error(mapRestoreError(json.error, json.message));
      }
      closeConfirm();
      setStatus(
        t("storage.trash.done", {
          count: String(json.count),
          size: formatBytes(json.bytes, locale),
        }),
      );
      onDone();
    } catch (e) {
      setError(localizedCatch(e, t("storage.trash.restoreFailed")));
    } finally {
      setBusy(false);
    }
  };

  const formatWhen = (entry: TrashEntry) => {
    const ms = entry.quarantinedAt ?? Number(entry.epoch.split("-")[0]);
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    return new Date(ms).toLocaleString(locale);
  };

  const modeLabel = (mode: TrashEntry["mode"]) => {
    if (mode === "permanent") return t("storage.trash.mode.permanent");
    if (mode === "quarantine") return t("storage.trash.mode.quarantine");
    return "—";
  };

  return (
    <section className="storage-cleanup-pane storage-quarantine-pane">
      <p className="muted storage-manual-panel__help">
        {t("storage.trash.help")}
      </p>

      {status && <p className="muted storage-manual-panel__status">{status}</p>}
      {error && !confirmEntry && (
        <p
          className="storage-manual-panel__status"
          style={{ color: "var(--red)" }}
        >
          {error}
        </p>
      )}

      {loading ? (
        <p className="muted storage-manual-panel__status">
          {t("storage.trash.loading")}
        </p>
      ) : entries.length === 0 ? (
        <p className="muted storage-manual-panel__status">
          {t("storage.trash.empty")}
        </p>
      ) : (
        <div className="tbl-wrap storage-manual-panel__table">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("storage.trash.col.when")}</th>
                <th className="num">{t("storage.trash.col.files")}</th>
                <th className="num">{t("storage.trash.col.size")}</th>
                <th>{t("storage.trash.col.mode")}</th>
                <th>{t("storage.trash.col.id")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="muted">{formatWhen(entry)}</td>
                  <td className="num">{entry.fileCount}</td>
                  <td className="num mono">
                    {formatBytes(entry.bytes, locale)}
                  </td>
                  <td className="muted">{modeLabel(entry.mode)}</td>
                  <td
                    className="mono"
                    style={{ fontSize: "var(--text-caption)" }}
                  >
                    {entry.id}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setConfirmEntry(entry);
                      }}
                    >
                      {t("storage.trash.restore")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmEntry && (
        <StorageConfirmDialog
          labelledBy="storage-trash-confirm-title"
          onDismiss={() => !busy && closeConfirm()}
        >
          <h3 id="storage-trash-confirm-title">
            {t("storage.trash.confirmTitle")}
          </h3>
          <p>
            {t("storage.trash.confirmBody", {
              count: String(confirmEntry.fileCount),
              size: formatBytes(confirmEntry.bytes, locale),
              id: confirmEntry.id,
            })}
          </p>
          {error && (
            <p style={{ marginTop: 12, color: "var(--red)" }}>{error}</p>
          )}
          <StorageConfirmActions>
            <button
              ref={cancelRef}
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => closeConfirm()}
            >
              {t("storage.trash.cancel")}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void runRestore()}
            >
              {t("storage.trash.confirmRestore")}
            </button>
          </StorageConfirmActions>
        </StorageConfirmDialog>
      )}
    </section>
  );
}
