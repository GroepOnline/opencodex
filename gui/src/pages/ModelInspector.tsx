import { useEffect, useRef } from "react";
import { useT } from "../i18n/shared";
import { IconBoxes, IconChevron } from "../icons";
import { Switch } from "../ui";
import { modelLabel } from "../model-display";
import type { ProviderModelGroup } from "../models-groups";
import { discoveryFailureLabel, fmtK, type ModelRow } from "./models-shared";

export default function ModelInspector({
  model,
  group,
  visible,
  busy,
  onClose,
  onToggle,
  onEdit,
  onDelete,
}: {
  model: ModelRow | null;
  group?: ProviderModelGroup<ModelRow>;
  visible: boolean;
  busy: boolean;
  onClose: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [model?.namespaced]);

  return (
    <aside
      id="model-inspector"
      className={`model-inspector${model ? " is-populated" : ""}`}
      aria-label={t("models.workspace.mainAria")}
    >
      {model ? (
        <>
          <button
            type="button"
            className="btn btn-ghost model-inspector-back"
            onClick={onClose}
          >
            <IconChevron
              width={14}
              height={14}
              aria-hidden="true"
              style={{ transform: "rotate(180deg)" }}
            />
            {t("models.workspace.back")}
          </button>
          <div className="model-inspector-heading">
            <span className="model-inspector-provider">{model.provider}</span>
            <h3 ref={headingRef} tabIndex={-1}>
              {model.displayName || modelLabel(model.id)}
            </h3>
            <code>{model.native ? model.id : model.namespaced}</code>
            {model.custom && (
              <span className="models-chip">{t("models.customBadge")}</span>
            )}
          </div>
          <div className="model-inspector-visibility">
            <div>
              <strong>{t("models.workspace.visibility")}</strong>
              <span>
                {visible
                  ? t("models.workspace.shown")
                  : t("models.workspace.hidden")}
              </span>
            </div>
            <Switch
              on={visible}
              onClick={onToggle}
              disabled={busy}
              label={t("models.workspace.changeVisibility")}
            />
          </div>
          {group?.discovery?.status === "failed" && (
            <p className="model-inspector-warning" role="status">
              {discoveryFailureLabel(t, group.discovery)}
            </p>
          )}
          {group?.clientHideReason && (
            <p className="model-inspector-warning" role="status">
              {group.clientHideReasonLabel ||
                t(
                  group.clientHidden
                    ? "models.clientHiddenBadge"
                    : "models.clientDegradedBadge",
                )}
            </p>
          )}
          <dl className="model-inspector-facts">
            <div>
              <dt>{t("models.tipContext")}</dt>
              <dd>
                {model.contextWindow
                  ? fmtK(model.contextWindow)
                  : t("models.workspace.unknown")}
              </dd>
            </div>
            {model.contextCapped && (
              <div>
                <dt>{t("models.workspace.contextLimit")}</dt>
                <dd>
                  {model.contextCap
                    ? fmtK(model.contextCap)
                    : t("models.workspace.unknown")}
                </dd>
              </div>
            )}
            <div>
              <dt>{t("models.tipModalities")}</dt>
              <dd>
                {model.inputModalities?.length
                  ? model.inputModalities.join(", ")
                  : t("models.workspace.unknown")}
              </dd>
            </div>
            {model.native && (
              <div>
                <dt>{t("models.tipProvider")}</dt>
                <dd>{t("models.nativeGroupLabel")}</dd>
              </div>
            )}
          </dl>
          <p className="model-inspector-provenance">
            {t("models.workspace.catalogNotHealth")}
          </p>
          {model.custom && model.customId && (
            <div className="model-inspector-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={onEdit}
              >
                {t("models.customEdit")}
              </button>
              <button
                type="button"
                className="btn btn-ghost model-inspector-delete"
                disabled={busy}
                onClick={onDelete}
              >
                {t("models.customDelete")}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="model-inspector-empty">
          <IconBoxes size={24} aria-hidden />
          <h3>{t("models.workspace.chooseModel")}</h3>
          <p>{t("models.workspace.chooseModelHint")}</p>
        </div>
      )}
    </aside>
  );
}
