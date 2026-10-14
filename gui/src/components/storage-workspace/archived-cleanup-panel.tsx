import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale, TFn } from "../../i18n/shared";
import { formatBytes } from "../../format-bytes";
import { PRESETS, localizedCatch } from "./storage-cleanup-policy";
import type { CleanupPreview, CleanupResult } from "./storage-types";
import { StorageConfirmActions, StorageConfirmDialog } from "./storage-confirm";

export function ArchivedCleanupPanel({
  apiBase,
  locale,
  t,
  onDone,
}: {
  apiBase: string;
  locale: Locale;
  t: TFn;
  onDone: () => void;
}) {
  const [percent, setPercent] = useState(25);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [permanent, setPermanent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);

  const closeConfirm = useCallback((clearPreview = false) => {
    setConfirmOpen(false);
    setPermanent(false);
    if (clearPreview) setPreview(null);
  }, []);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!confirmOpen) return;
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
  }, [confirmOpen, closeConfirm]);

  const mapCleanupError = (
    code: string | undefined,
    fallback?: string,
    trashDir?: string,
  ) => {
    switch (code) {
      case "codex_busy":
        return t("storage.cleanup.err.codex_busy");
      case "stale_preview":
        return t("storage.cleanup.err.stale_preview");
      case "restore_pending_overlap":
        return t("storage.cleanup.err.restore_pending_overlap");
      case "referenced_history":
        return t("storage.cleanup.err.referenced_history");
      case "invalid_digest":
        return t("storage.cleanup.err.invalid_digest");
      case "invalid_mode":
        return t("storage.cleanup.err.invalid_mode");
      case "fs_failed":
        return trashDir
          ? t("storage.cleanup.err.fs_failed_trash", { trashDir })
          : t("storage.cleanup.err.fs_failed");
      case "db_reconcile_failed":
        return t("storage.cleanup.err.db_reconcile_failed");
      case "cleanup_failed":
        return t("storage.cleanup.err.cleanup_failed");
      default:
        return fallback ?? t("storage.cleanup.cleanupFailed");
    }
  };

  const formatPreset = (value: number) =>
    t("storage.cleanup.preset", {
      percent: new Intl.NumberFormat(locale, {
        style: "percent",
        maximumFractionDigits: 0,
      }).format(value / 100),
    });

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/cleanup/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          mapCleanupError(json.error, t("storage.cleanup.previewFailed")),
        );
      }
      const json = (await res.json()) as CleanupPreview;
      setPreview(json);
      setConfirmOpen(true);
    } catch (e) {
      setError(localizedCatch(e, t("storage.cleanup.previewFailed")));
    } finally {
      setBusy(false);
    }
  };

  const runCleanup = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/cleanup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          percent: preview.percent,
          mode: permanent ? "permanent" : "quarantine",
          digest: preview.digest,
        }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as CleanupResult;
        if (json.error === "stale_preview") {
          // Digest can never succeed again — send the user back to Preview.
          closeConfirm(true);
        }
        throw new Error(
          mapCleanupError(json.error, json.message, json.trashDir),
        );
      }
      const json = (await res.json()) as CleanupResult;
      if (!json.ok) {
        if (json.error === "stale_preview") {
          closeConfirm(true);
        }
        throw new Error(
          mapCleanupError(json.error, json.message, json.trashDir),
        );
      }
      closeConfirm(true);
      setStatus(
        permanent
          ? t("storage.cleanup.donePermanent", {
              count: String(json.count),
              size: formatBytes(json.bytes, locale),
            })
          : t("storage.cleanup.doneQuarantine", {
              count: String(json.count),
              size: formatBytes(json.bytes, locale),
            }),
      );
      onDone();
    } catch (e) {
      // Keep the dialog open (except stale_preview) so the failure is visible.
      setError(localizedCatch(e, t("storage.cleanup.cleanupFailed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="storage-cleanup-pane">
      <p className="muted storage-manual-panel__help">
        {t("storage.cleanup.help")}
      </p>

      <div className="storage-manual-panel__controls">
        <label className="storage-manual-panel__slider">
          <span
            className="muted mono"
            style={{ minWidth: "3.5rem", fontVariantNumeric: "tabular-nums" }}
          >
            {t("storage.cleanup.percent", { percent: String(percent) })}
          </span>
          <input
            type="range"
            min={1}
            max={100}
            value={percent}
            onChange={(e) => setPercent(Number(e.target.value))}
            disabled={busy}
            style={{ flex: 1, minWidth: 0 }}
            aria-label={t("storage.cleanup.slider")}
          />
        </label>
        <div className="storage-manual-panel__presets">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className={`btn btn-ghost btn-sm${percent === p ? " active" : ""}`}
              disabled={busy}
              onClick={() => setPercent(p)}
            >
              {formatPreset(p)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => void runPreview()}
        >
          {t("storage.cleanup.preview")}
        </button>
      </div>

      {status && <p className="muted storage-manual-panel__status">{status}</p>}
      {error && !confirmOpen && (
        <p
          className="storage-manual-panel__status"
          style={{ color: "var(--red)" }}
        >
          {error}
        </p>
      )}

      {confirmOpen && preview && (
        <StorageConfirmDialog
          labelledBy="storage-cleanup-confirm-title"
          onDismiss={() => !busy && closeConfirm()}
        >
          <h3 id="storage-cleanup-confirm-title">
            {t("storage.cleanup.confirmTitle")}
          </h3>
          <p>
            {t("storage.cleanup.confirmBody", {
              count: String(preview.count),
              size: formatBytes(preview.bytes, locale),
              percent: String(preview.percent),
            })}
          </p>
          {preview.candidates.length > 0 && (
            <ul
              className="mono muted"
              style={{
                maxHeight: 160,
                overflow: "auto",
                fontSize: "var(--text-caption)",
              }}
            >
              {preview.candidates.slice(0, 8).map((c) => (
                <li key={c.relPath}>{c.relPath}</li>
              ))}
              {preview.count > 8 && (
                <li>
                  {t("storage.cleanup.moreFiles", {
                    n: String(Math.max(0, preview.count - 8)),
                  })}
                </li>
              )}
            </ul>
          )}
          <label
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginTop: 12,
            }}
          >
            <input
              type="checkbox"
              checked={permanent}
              disabled={busy}
              onChange={(e) => setPermanent(e.target.checked)}
            />
            <span>{t("storage.cleanup.permanent")}</span>
          </label>
          <p
            className="muted"
            style={{ marginTop: 8, fontSize: "var(--text-caption)" }}
          >
            {permanent
              ? t("storage.cleanup.permanentWarn")
              : t("storage.cleanup.quarantineNote")}
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
              {t("storage.cleanup.cancel")}
            </button>
            <button
              type="button"
              className={permanent ? "btn btn-danger" : "btn"}
              disabled={busy || preview.count === 0}
              onClick={() => void runCleanup()}
            >
              {permanent
                ? t("storage.cleanup.confirmPermanent")
                : t("storage.cleanup.confirmQuarantine")}
            </button>
          </StorageConfirmActions>
        </StorageConfirmDialog>
      )}
    </section>
  );
}
