/**
 * Modal shown before starting OAuth for providers whose subscription tokens
 * are restricted (or risky) when used outside the official client.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { IconAlert } from "../icons";
import {
  oauthTosRisk,
  oauthTosRiskBodyKey,
  oauthTosRiskTitleKey,
} from "../oauth-tos-risk";
import {
  ModalActions,
  ModalBackdrop,
  ModalCard,
  ModalDesc,
  ModalDialog,
  ModalHead,
} from "./primitives/modal";

export default function OAuthTosWarningModal({
  providerId,
  providerLabel,
  onCancel,
  onContinue,
}: {
  providerId: string;
  providerLabel: string;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submittedRef = useRef(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const level = oauthTosRisk(providerId);

  // Open as a native modal dialog — provides focus trapping and backdrop for free.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // Native <dialog> fires "cancel" on Escape — forward it to our handler.
  const handleCancel = useCallback(
    (e: React.SyntheticEvent) => {
      e.preventDefault();
      onCancel();
    },
    [onCancel],
  );

  // Unmarked provider: render nothing (callers must gate with oauthTosRisk).
  if (!level) return null;

  const normalizedProviderId = providerId.trim().toLowerCase();
  const bodyKey =
    normalizedProviderId === "anthropic"
      ? "oauthTos.anthropicBody"
      : oauthTosRiskBodyKey(level);
  const showApiKeySaferPath =
    normalizedProviderId === "anthropic" ||
    normalizedProviderId === "google-antigravity";

  const handleContinue = () => {
    if (!acknowledged || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitted(true);
    onContinue();
  };

  return (
    <ModalDialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={handleCancel}
    >
      <ModalBackdrop aria-label={t("common.close")} onClick={onCancel} />
      <ModalCard className="modal-card oauth-tos-card">
        <ModalHead
          titleId={titleId}
          title={t(oauthTosRiskTitleKey(level), { provider: providerLabel })}
        />
        <div
          id={bodyId}
          className="notice-warn"
          style={{
            marginTop: 12,
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
          }}
        >
          <IconAlert
            width={15}
            height={15}
            style={{ flexShrink: 0, marginTop: 2 }}
            aria-hidden="true"
          />
          <ModalDesc style={{ margin: 0 }}>
            {t(bodyKey, { provider: providerLabel })}
          </ModalDesc>
        </div>
        {showApiKeySaferPath && (
          <p className="muted text-label" style={{ marginTop: 12 }}>
            {t("oauthTos.saferPath")}
          </p>
        )}
        <label
          className="oauth-tos-ack"
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            marginTop: 14,
          }}
        >
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            style={{ marginTop: 3 }}
            aria-required="true"
          />
          <span className="text-label">{t("oauthTos.acknowledge")}</span>
        </label>
        <ModalActions>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!acknowledged || submitted}
            onClick={handleContinue}
          >
            {t("oauthTos.continue")}
          </button>
        </ModalActions>
      </ModalCard>
    </ModalDialog>
  );
}
