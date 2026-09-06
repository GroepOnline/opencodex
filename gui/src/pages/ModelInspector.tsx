import { useEffect, useRef } from "react";
import { useT } from "../i18n/shared";
import { IconCheck, IconChevron, IconServer } from "../icons";
import MatrixMark from "../components/MatrixMark";
import { Button } from "../components/primitives/button";
import { Badge } from "../components/primitives/badge";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "../components/primitives/field";
import { Alert, AlertDescription } from "../components/primitives/alert";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../components/primitives/accordion";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "../components/primitives/empty";
import { Separator } from "../components/primitives/separator";
import { useCopyFeedback } from "../components/use-copy-feedback";
import { Switch } from "../components/primitives/switch";
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
  const idCopy = useCopyFeedback<string>();
  const copyOutcome = model ? idCopy.outcomeFor(model.namespaced) : null;
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
          <Button
            type="button"
            variant="ghost"
            className="model-inspector-back"
            onClick={onClose}
          >
            <IconChevron
              width={14}
              height={14}
              aria-hidden="true"
              style={{ transform: "rotate(180deg)" }}
            />
            {t("models.workspace.back")}
          </Button>
          <div className="model-inspector-heading">
            <span className="model-inspector-provider">
              <IconServer size={15} aria-hidden />
              {model.provider}
            </span>
            <h3 ref={headingRef} tabIndex={-1}>
              {model.displayName || modelLabel(model.id)}
            </h3>
            {model.custom && (
              <Badge variant="secondary">{t("models.customBadge")}</Badge>
            )}
          </div>
          <div
            className="model-inspector-identifier"
            data-copy-outcome={copyOutcome ?? undefined}
          >
            <div className="model-inspector-identifier-head">
              <span>{t("models.workspace.modelId")}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  idCopy.copy(
                    model.native ? model.id : model.namespaced,
                    model.namespaced,
                  )
                }
              >
                {copyOutcome === "copied" && (
                  <IconCheck size={13} aria-hidden />
                )}
                <span aria-live="polite">
                  {copyOutcome === "copied"
                    ? t("api.copied")
                    : copyOutcome === "unavailable"
                      ? t("models.workspace.copyUnavailable")
                      : t("models.workspace.copyId")}
                </span>
              </Button>
            </div>
            <code>{model.native ? model.id : model.namespaced}</code>
          </div>
          <FieldGroup className="model-inspector-visibility">
            <Field orientation="horizontal" data-disabled={busy || undefined}>
              <FieldContent>
                <FieldLabel htmlFor="model-inspector-visibility">
                  {t("models.workspace.visibility")}
                </FieldLabel>
                <FieldDescription id="model-inspector-visibility-hint">
                  {visible
                    ? t("models.workspace.shown")
                    : t("models.workspace.hidden")}
                </FieldDescription>
              </FieldContent>
              <Switch
                size="touch"
                id="model-inspector-visibility"
                checked={visible}
                onCheckedChange={onToggle}
                disabled={busy}
                aria-label={t("models.workspace.changeVisibility")}
                aria-describedby="model-inspector-visibility-hint"
              />
            </Field>
          </FieldGroup>
          <Separator />
          {group?.discovery?.status === "failed" && (
            <Alert role="status">
              <AlertDescription>
                {discoveryFailureLabel(t, group.discovery)}
              </AlertDescription>
            </Alert>
          )}
          {group?.clientHideReason && (
            <Alert role="status">
              <AlertDescription>
                {group.clientHideReasonLabel ||
                  t(
                    group.clientHidden
                      ? "models.clientHiddenBadge"
                      : "models.clientDegradedBadge",
                  )}
              </AlertDescription>
            </Alert>
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
          <Accordion className="model-inspector-provenance">
            <AccordionItem value="provenance">
              <AccordionTrigger>
                {t("models.workspace.catalogEvidence")}
              </AccordionTrigger>
              <AccordionContent>
                {t("models.workspace.catalogNotHealth")}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
          {model.custom && model.customId && (
            <div className="model-inspector-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onEdit}
              >
                {t("models.customEdit")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={onDelete}
              >
                {t("models.customDelete")}
              </Button>
            </div>
          )}
        </>
      ) : (
        <Empty className="model-inspector-empty">
          <EmptyHeader>
            <EmptyMedia>
              <MatrixMark />
            </EmptyMedia>
            <EmptyTitle>{t("models.workspace.chooseModel")}</EmptyTitle>
            <EmptyDescription>
              {t("models.workspace.chooseModelHint")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </aside>
  );
}
