/**
 * ProviderDialogs — confirmation and warning dialogs for the workspace
 * Settings tab (WP091): remove provider, unsaved-leave, JSON save-before-leave.
 */
import { useT } from "../../i18n/shared";
import {
  WorkspaceDialog,
  WorkspaceDialogActions,
  WorkspaceDialogBackdrop,
  WorkspaceDialogBody,
  WorkspaceDialogTitle,
} from "../primitives/workspace-dialog";

export function RemoveConfirmDialog({
  providerName, onConfirm, onCancel,
}: {
  providerName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <WorkspaceDialogBackdrop onClick={onCancel}>
      <WorkspaceDialog aria-label={t("pws.removeConfirmTitle")}>
        <WorkspaceDialogTitle>{t("pws.removeConfirmTitle")}</WorkspaceDialogTitle>
        <WorkspaceDialogBody>{t("pws.removeConfirmBody", { name: providerName })}</WorkspaceDialogBody>
        <WorkspaceDialogActions>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>{t("pws.removeConfirm")}</button>
        </WorkspaceDialogActions>
      </WorkspaceDialog>
    </WorkspaceDialogBackdrop>
  );
}

export function UnsavedLeaveDialog({
  onSave, onDiscard, onCancel, saving = false,
}: {
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  const t = useT();
  return (
    <WorkspaceDialogBackdrop onClick={onCancel}>
      <WorkspaceDialog aria-label={t("pws.unsavedLeaveTitle")}>
        <WorkspaceDialogTitle>{t("pws.unsavedLeaveTitle")}</WorkspaceDialogTitle>
        <WorkspaceDialogBody>{t("pws.unsavedLeaveBody")}</WorkspaceDialogBody>
        <WorkspaceDialogActions>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-ghost" onClick={onDiscard}>{t("pws.discardSettings")}</button>
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving}>
            {saving ? t("pws.saving") : t("pws.saveSettings")}
          </button>
        </WorkspaceDialogActions>
      </WorkspaceDialog>
    </WorkspaceDialogBackdrop>
  );
}
