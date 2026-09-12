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
import {
  Inspector,
  InspectorActions,
  InspectorHeading,
} from "../components/primitives/inspector";
import { Metric, MetricGroup } from "../components/primitives/metric";
import { Separator } from "../components/primitives/separator";
import {
  useCopyFeedback,
  type CopyOutcome,
} from "../components/use-copy-feedback";
import { Switch } from "../components/primitives/switch";
import { modelLabel } from "../model-display";
import type { ProviderModelGroup } from "../models-groups";
import { discoveryFailureLabel, fmtK, type ModelRow } from "./models-shared";

function ModelIdentifier({
  model,
  copyOutcome,
  onCopy,
}: {
  model: ModelRow;
  copyOutcome: CopyOutcome | null;
  onCopy: (text: string, scope: string) => void;
}) {
  const t = useT();
  return (
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
            onCopy(model.native ? model.id : model.namespaced, model.namespaced)
          }
        >
          {copyOutcome === "copied" && <IconCheck size={13} aria-hidden />}
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
  );
}

function ModelDiscoveryWarnings({
  group,
}: {
  group?: ProviderModelGroup<ModelRow>;
}) {
  const t = useT();
  return (
    <>
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
    </>
  );
}

function ModelFacts({ model }: { model: ModelRow }) {
  const t = useT();
  const unknown = t("models.workspace.unknown");
  return (
    <MetricGroup
      label={t("models.workspace.mainAria")}
      className="model-inspector-facts"
    >
      <Metric
        label={t("models.tipContext")}
        value={model.contextWindow ? fmtK(model.contextWindow) : unknown}
      />
      {model.contextCapped ? (
        <Metric
          label={t("models.workspace.contextLimit")}
          value={model.contextCap ? fmtK(model.contextCap) : unknown}
        />
      ) : null}
      <Metric
        label={t("models.tipModalities")}
        value={
          model.inputModalities?.length
            ? model.inputModalities.join(", ")
            : unknown
        }
      />
      {model.native ? (
        <Metric
          label={t("models.tipProvider")}
          value={t("models.nativeGroupLabel")}
        />
      ) : null}
    </MetricGroup>
  );
}

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
  visible: boolean;
  busy: boolean;
  onClose: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  group?: ProviderModelGroup<ModelRow>;
}) {
  const t = useT();
  const idCopy = useCopyFeedback<string>();
  const copyOutcome = model ? idCopy.outcomeFor(model.namespaced) : null;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [model?.namespaced]);

  return (
    <Inspector
      id="model-inspector"
      className="model-inspector"
      populated={Boolean(model)}
      label={t("models.workspace.mainAria")}
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
          <InspectorHeading
            className="model-inspector-heading"
            kickerClassName="model-inspector-provider"
            headingRef={headingRef}
            kicker={
              <>
                <IconServer size={15} aria-hidden />
                {model.provider}
              </>
            }
            title={model.displayName || modelLabel(model.id)}
            badge={
              model.custom ? (
                <Badge variant="secondary">{t("models.customBadge")}</Badge>
              ) : null
            }
          />
          <ModelIdentifier
            model={model}
            copyOutcome={copyOutcome}
            onCopy={idCopy.copy}
          />
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
          <ModelDiscoveryWarnings group={group} />
          <ModelFacts model={model} />
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
          {model.custom && model.customId ? (
            <InspectorActions className="model-inspector-actions">
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
            </InspectorActions>
          ) : null}
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
    </Inspector>
  );
}
