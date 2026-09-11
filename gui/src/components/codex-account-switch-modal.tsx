import { useCallback, useEffect, useRef } from "react";
import { useT } from "../i18n/shared";
import { IconAlert } from "../icons";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import type { CodexAccountModeState } from "../codex-multi-state";
import {
  ModalActions,
  ModalBackdrop,
  ModalCard,
  ModalDesc,
  ModalDialog,
} from "./primitives/modal";

export function CodexAccountSwitchModal({
  confirm,
  mainEmail,
  accountModeState,
  switchingId,
  onCancel,
  onConfirm,
}: {
  confirm: CodexAccountEntry;
  mainEmail?: string;
  accountModeState: CodexAccountModeState | null;
  switchingId: string | null;
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
      aria-labelledby="codex-switch-title"
      onCancel={handleCancel}
    >
      <ModalBackdrop aria-label={t("common.close")} onClick={onCancel} />
      <ModalCard onClick={(e) => e.stopPropagation()} role="document">
        <h3 id="codex-switch-title">
          {accountModeState === "direct"
            ? t("codexAuth.preparePoolTitle")
            : confirm.id === "__main__"
              ? t("codexAuth.switchBack")
              : t("codexAuth.switchTitle")}
        </h3>
        <ModalDesc>
          {accountModeState === "direct"
            ? t("codexAuth.preparePoolDesc")
            : confirm.id === "__main__"
              ? t("codexAuth.switchBackDesc")
              : t("codexAuth.switchDesc")}
        </ModalDesc>
        <div className="card" style={{ margin: "12px 0" }}>
          <strong>
            {confirm.id === "__main__"
              ? mainEmail || t("codexAuth.codexApp")
              : confirm.email}
          </strong>
          {confirm.plan && (
            <span className="badge badge-green" style={{ marginLeft: 8 }}>
              {confirm.plan}
            </span>
          )}
        </div>
        {confirm.id !== "__main__" && (
          <div className="notice-warn">
            <IconAlert width={15} /> {t("codexAuth.cacheWarning")}
          </div>
        )}
        <ModalActions>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {t("codexAuth.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={Boolean(switchingId)}
            onClick={onConfirm}
          >
            {switchingId
              ? t("pws.accountSwitching")
              : t(
                  accountModeState === "direct"
                    ? "codexAuth.prepareForPool"
                    : "codexAuth.setAsNext",
                )}
          </button>
        </ModalActions>
      </ModalCard>
    </ModalDialog>
  );
}
