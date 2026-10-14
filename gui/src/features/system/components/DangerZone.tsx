import { useEffect, useRef, useState, type Ref } from "react";
import { useT } from "../../../i18n/shared";
import { IconPower } from "../../../icons";
import { requestProxyStop } from "../../../stop-proxy";
import { Modal, ModalActions, ModalCard, ModalDesc, ModalHead } from "../../../components/primitives/modal";

const API_BASE = import.meta.env.VITE_API_BASE || "";

/** Danger zone (Systeem home): destructive actions live here — named, separated,
    and behind an explicit confirmation. Never in navigation. */
function StopProxyDialog({
  stopping,
  cancelRef,
  title,
  body,
  cancelLabel,
  stopLabel,
  stoppingLabel,
  onCancel,
  onConfirm,
}: {
  stopping: boolean;
  cancelRef: Ref<HTMLButtonElement>;
  title: string;
  body: string;
  cancelLabel: string;
  stopLabel: string;
  stoppingLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      role="alertdialog"
      aria-labelledby="stop-proxy-title"
      aria-describedby="stop-proxy-desc"
      onClick={(e) => {
        if (e.target === e.currentTarget && !stopping) onCancel();
      }}
    >
      <ModalCard className="modal-card modal-card--narrow">
        <ModalHead titleId="stop-proxy-title" title={title} />
        <ModalDesc id="stop-proxy-desc">{body}</ModalDesc>
        <ModalActions>
          <button
            ref={cancelRef}
            type="button"
            className="btn"
            onClick={onCancel}
            disabled={stopping}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={stopping}
          >
            <IconPower size={13} aria-hidden />{" "}
            {stopping ? stoppingLabel : stopLabel}
          </button>
        </ModalActions>
      </ModalCard>
    </Modal>
  );
}

export default function DangerZone() {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!confirming) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !stopping) setConfirming(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, stopping]);

  const handleStop = async () => {
    setStopping(true);
    const outcome = await requestProxyStop(API_BASE, {
      formatFailure: (status) =>
        t("dash.stopFailed", { status: String(status) }),
    });
    // Refusals and restore failures return normally instead of dropping the connection.
    // In both cases the proxy did not reach a clean-stop result, so surface the server's
    // remediation instead of leaving "stopping…" stuck forever.
    if (!outcome.accepted) {
      setStopping(false);
      setConfirming(false);
      alert(outcome.message);
    }
  };

  return (
    <section className="danger-zone" aria-labelledby="danger-zone-title">
      <h3 id="danger-zone-title" className="danger-title">
        {t("danger.title")}
      </h3>
      <div className="danger-row">
        <div className="danger-copy">
          <div className="danger-action">{t("danger.stopAction")}</div>
          <div className="muted">{t("danger.stopBody")}</div>
        </div>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => setConfirming(true)}
        >
          <IconPower size={13} aria-hidden /> {t("dash.stop")}
        </button>
      </div>

      {confirming && (
        <StopProxyDialog
          stopping={stopping}
          cancelRef={cancelRef}
          title={t("danger.stopTitle")}
          body={t("danger.stopBody")}
          cancelLabel={t("common.cancel")}
          stopLabel={t("danger.stopAction")}
          stoppingLabel={t("dash.stopping")}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void handleStop()}
        />
      )}
    </section>
  );
}
