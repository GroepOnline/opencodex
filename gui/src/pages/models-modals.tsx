import type { Dispatch, SetStateAction } from "react";
import { Notice, Select } from "../ui";
import { Button } from "../components/primitives/button";
import { Spinner } from "../components/primitives/spinner";
import {
  Modal,
  ModalActions,
  ModalCard,
  ModalDesc,
  ModalHead,
} from "../components/primitives/modal";
import { useT } from "../i18n/shared";
import { CUSTOM_OPTION } from "./models-shared";

type ModelsModalsProps = {
  v2HelpOpen: boolean;
  setV2HelpOpen: (open: boolean) => void;
  customModalOpen: boolean;
  setCustomModalOpen: (open: boolean) => void;
  customSaving: boolean;
  customModalMode: "add" | "edit";
  customModalProvider: string;
  customError: string;
  customFormModelId: string;
  setCustomFormModelId: (value: string) => void;
  customFormDisplayName: string;
  setCustomFormDisplayName: (value: string) => void;
  customFormShowCustomCtx: boolean;
  setCustomFormShowCustomCtx: (value: boolean) => void;
  customFormContextWindow: string;
  setCustomFormContextWindow: (value: string) => void;
  customFormModalities: string[];
  setCustomFormModalities: Dispatch<SetStateAction<string[]>>;
  onSaveCustom: () => void;
};

export function ModelsModals({
  v2HelpOpen,
  setV2HelpOpen,
  customModalOpen,
  setCustomModalOpen,
  customSaving,
  customModalMode,
  customModalProvider,
  customError,
  customFormModelId,
  setCustomFormModelId,
  customFormDisplayName,
  setCustomFormDisplayName,
  customFormShowCustomCtx,
  setCustomFormShowCustomCtx,
  customFormContextWindow,
  setCustomFormContextWindow,
  customFormModalities,
  setCustomFormModalities,
  onSaveCustom,
}: ModelsModalsProps) {
  const t = useT();
  return (
    <>
      {v2HelpOpen && (
        <Modal
          aria-label={t("models.v2Label")}
          onClick={() => setV2HelpOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setV2HelpOpen(false);
          }}
        >
          <ModalCard onClick={(e) => e.stopPropagation()}>
            <ModalHead
              title={t("models.v2Label")}
              actions={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className=""
                  onClick={() => setV2HelpOpen(false)}
                  aria-label={t("common.close")}
                >
                  &times;
                </Button>
              }
            />
            <ModalDesc
              className="modal-desc leading-relaxed"
              style={{ whiteSpace: "pre-line" }}
            >
              {t("models.v2Help")}
            </ModalDesc>
            <div className="models-help-link">
              <a
                className="text-control"
                href="https://opencodex.me/guides/sub-agent-surface/"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)" }}
              >
                {t("models.v2DocsLink")}
              </a>
            </div>
            <ModalActions>
              <Button
                type="button"
                variant="default"
                className=""
                onClick={() => setV2HelpOpen(false)}
              >
                {t("common.ok")}
              </Button>
            </ModalActions>
          </ModalCard>
        </Modal>
      )}

      {customModalOpen && (
        <Modal
          aria-label={t("models.customAdd")}
          onClick={() => {
            if (!customSaving) setCustomModalOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !customSaving) setCustomModalOpen(false);
          }}
        >
          <ModalCard onClick={(e) => e.stopPropagation()}>
            <ModalHead
              title={
                customModalMode === "add"
                  ? t("models.customAddTitle", {
                      provider: customModalProvider,
                    })
                  : t("models.customEditTitle", {
                      provider: customModalProvider,
                    })
              }
              actions={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className=""
                  onClick={() => setCustomModalOpen(false)}
                  disabled={customSaving}
                  aria-label={t("common.close")}
                >
                  &times;
                </Button>
              }
            />

            {customError && <Notice tone="err">{customError}</Notice>}

            <div className="models-field-stack">
              <label className="text-label models-field">
                {t("models.customFieldModelId")}
                <input
                  className="input"
                  value={customFormModelId}
                  onChange={(e) => setCustomFormModelId(e.target.value)}
                  disabled={customSaving}
                  placeholder={t("models.customFieldModelIdPlaceholder")}
                  autoFocus
                />
              </label>

              <label className="text-label models-field">
                {t("models.customFieldDisplayName")}
                <input
                  className="input"
                  value={customFormDisplayName}
                  onChange={(e) => setCustomFormDisplayName(e.target.value)}
                  disabled={customSaving}
                  placeholder={t("models.customFieldDisplayNamePlaceholder")}
                />
              </label>

              <label className="text-label models-field">
                {t("models.customFieldContext")}
                <div className="row models-field-row">
                  <Select
                    value={
                      customFormShowCustomCtx
                        ? CUSTOM_OPTION
                        : customFormContextWindow
                    }
                    options={[
                      { value: "", label: "—" },
                      { value: "100000", label: "100k" },
                      { value: "128000", label: "128k" },
                      { value: "200000", label: "200k" },
                      { value: "256000", label: "256k" },
                      { value: "352000", label: "352k" },
                      { value: "500000", label: "500k" },
                      { value: "1000000", label: "1M" },
                      { value: CUSTOM_OPTION, label: t("models.custom") },
                    ]}
                    onChange={(v) => {
                      if (v === CUSTOM_OPTION) {
                        setCustomFormShowCustomCtx(true);
                        return;
                      }
                      setCustomFormShowCustomCtx(false);
                      setCustomFormContextWindow(v);
                    }}
                    disabled={customSaving}
                    label={t("models.customFieldContext")}
                  />
                  {customFormShowCustomCtx && (
                    <input
                      className="input"
                      style={{ width: 120 }}
                      inputMode="numeric"
                      value={customFormContextWindow}
                      onChange={(e) =>
                        setCustomFormContextWindow(e.target.value)
                      }
                      disabled={customSaving}
                      placeholder={t("models.customPlaceholder")}
                      aria-label={t("models.customFieldContext")}
                    />
                  )}
                </div>
              </label>

              <div className="text-label models-field">
                {t("models.customFieldModalities")}
                <div className="row models-field-row">
                  {(["text", "image", "audio"] as const).map((mod) => (
                    <label key={mod} className="row models-modality-option">
                      <input
                        type="checkbox"
                        checked={customFormModalities.includes(mod)}
                        onChange={(e) => {
                          setCustomFormModalities((prev) =>
                            e.target.checked
                              ? [...prev, mod]
                              : prev.filter((m) => m !== mod),
                          );
                        }}
                        disabled={customSaving}
                      />
                      <span className="text-control">{mod}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <ModalActions>
              <Button
                type="button"
                variant="ghost"
                className=""
                onClick={() => setCustomModalOpen(false)}
                disabled={customSaving}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                variant="default"
                className=""
                disabled={customSaving || !customFormModelId.trim()}
                onClick={onSaveCustom}
              >
                {customSaving && (
                  <Spinner aria-hidden data-icon="inline-start" />
                )}
                {customSaving
                  ? t("models.customSaving")
                  : customModalMode === "add"
                    ? t("models.customAddBtn")
                    : t("models.customEditBtn")}
              </Button>
            </ModalActions>
          </ModalCard>
        </Modal>
      )}
    </>
  );
}
