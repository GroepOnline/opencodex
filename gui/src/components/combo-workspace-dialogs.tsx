import { useCallback, useEffect, useRef } from "react";
import { useT } from "../i18n/shared";
import {
  ModalActions,
  ModalBackdrop,
  ModalCard,
  ModalDialog,
} from "./primitives/modal";

export function RemoveComboDialog({
  model,
  onCancel,
  onConfirm,
}: {
  model: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const handleCancel = useCallback(
    (e: React.SyntheticEvent) => {
      e.preventDefault();
      onCancel();
    },
    [onCancel],
  );

  return (
    <ModalDialog
      ref={dialogRef}
      aria-labelledby="cwi-remove-title"
      onCancel={handleCancel}
    >
      <ModalBackdrop aria-label={t("common.close")} onClick={onCancel} />
      <ModalCard
        className="modal-card pwi-remove-confirm-card"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="cwi-remove-title" className="pwi-remove-confirm-title">
          {t("cws.removeConfirmTitle", { model })}
        </h3>
        <p className="muted pwi-remove-confirm-desc">
          {t("cws.removeConfirmDesc")}
        </p>
        <ModalActions className="pwi-remove-confirm-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn pwi-remove-confirm-danger"
            onClick={onConfirm}
          >
            {t("common.remove")}
          </button>
        </ModalActions>
      </ModalCard>
    </ModalDialog>
  );
}

export function UnsavedLeaveDialog({
  onKeep,
  onDiscard,
}: {
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const handleCancel = useCallback(
    (e: React.SyntheticEvent) => {
      e.preventDefault();
      onKeep();
    },
    [onKeep],
  );

  return (
    <ModalDialog
      ref={dialogRef}
      aria-labelledby="cwi-unsaved-title"
      onCancel={handleCancel}
    >
      <ModalBackdrop aria-label={t("common.close")} onClick={onKeep} />
      <ModalCard
        className="modal-card pwi-json-unsaved-card"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="cwi-unsaved-title" className="pwi-json-unsaved-title">
          {t("cws.unsavedTitle")}
        </h3>
        <p className="muted pwi-json-unsaved-desc">{t("cws.unsavedDesc")}</p>
        <ModalActions className="pwi-json-unsaved-actions">
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="cwi-unsaved-keep"
            onClick={onKeep}
          >
            {t("cws.keepEditing")}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            data-testid="cwi-unsaved-discard"
            onClick={onDiscard}
          >
            {t("common.discard")}
          </button>
        </ModalActions>
      </ModalCard>
    </ModalDialog>
  );
}
