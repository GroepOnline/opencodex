import { IconGlobe } from "../icons";
import { useT } from "../i18n/shared";
import { ModalActions, ModalDesc, ModalHead } from "./primitives/modal";

export function AddCodexAccountPickStep({
  id,
  error,
  onIdChange,
  onStartOAuth,
  onClose,
}: {
  id: string;
  error: string;
  onIdChange: (value: string) => void;
  onStartOAuth: () => void;
  onClose: () => void;
}) {
  const t = useT();

  return (
    <>
      <ModalHead title={t("codexAuth.addTitle")} />
      <ModalDesc>{t("codexAuth.addPickDesc")}</ModalDesc>

      <label className="field-label" htmlFor="codex-account-id-input">
        {t("codexAuth.addIdLabel")}
      </label>
      <input
        id="codex-account-id-input"
        className="input"
        placeholder={t("codexAuth.addIdPlaceholder")}
        value={id}
        onChange={(e) => onIdChange(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      <button
        type="button"
        className="list-row"
        onClick={onStartOAuth}
        style={{ marginBottom: 8 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <IconGlobe width={18} />
          <div>
            <div className="title">{t("codexAuth.oauthLogin")}</div>
            <div className="sub">{t("codexAuth.oauthDesc")}</div>
          </div>
        </div>
      </button>

      {error && (
        <div className="notice notice-err">
          {error}
        </div>
      )}

      <ModalActions>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onClose}
        >
          {t("codexAuth.cancel")}
        </button>
      </ModalActions>
    </>
  );
}
