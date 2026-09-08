import { Button } from "../components/primitives/button";
import { Badge } from "../components/primitives/badge";
import { Switch as LibrarySwitch } from "../components/primitives/switch";
import { Spinner } from "../components/primitives/spinner";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../components/primitives/accordion";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { Switch } from "../ui";
import { IconChevron } from "../icons";
import { useT } from "../i18n/shared";
import { modelLabel } from "../model-display";
import { modelVisible, type ProviderModelMap } from "../model-visibility";
import type {
  ConfiguredProviderSummary,
  ProviderModelGroup,
} from "../models-groups";
import { discoveryFailureLabel, fmtK, type ModelRow } from "./models-shared";
import { EmptyProviderHint } from "./models-provider-hints";

type ModelsProviderCardProps = {
  group: ProviderModelGroup<ModelRow>;
  selectedModels: ProviderModelMap;
  disabled: Set<string>;
  catalogQuery: string;
  collapsed: boolean;
  capOn: boolean;
  contextCapValue: number;
  configured: ConfiguredProviderSummary | undefined;
  shown: number;
  busy: boolean;
  fetchingProvider: string | null;
  selectedModelName: string | null;
  onSelectModel: (name: string, element: HTMLButtonElement) => void;
  onToggleVisibility: (model: ModelRow, enable: boolean) => void;
  onBulkToggle: (rows: ModelRow[], enable: boolean) => void;
  onToggleCollapse: () => void;
  onFetchModels: () => void;
  onAddCustom: () => void;
  onToggleCap: () => void;
  onShowMore: () => void;
};

// The page retains mutation/selection ownership; this component only derives and renders a group.
export function ModelsProviderCard({
  group,
  selectedModels,
  disabled,
  catalogQuery,
  collapsed,
  capOn,
  contextCapValue,
  configured,
  shown,
  busy,
  fetchingProvider,
  selectedModelName,
  onSelectModel,
  onToggleVisibility,
  onBulkToggle,
  onToggleCollapse,
  onFetchModels,
  onAddCustom,
  onToggleCap,
  onShowMore,
}: ModelsProviderCardProps) {
  const t = useT();
  const { provider, rows, native, liveModels, discovery } = group;
  const isCollapsed = !catalogQuery.trim() && collapsed;
  // Final visibility, not just the disable flag: a model is visible to Codex only when the
  // provider allowlist admits it AND it is not disabled. Reading `disabled` alone made the
  // switches disagree with what the picker actually offers.
  const isVisible = (model: ModelRow) =>
    modelVisible(
      selectedModels,
      provider,
      model.id,
      model.native === true,
      disabled.has(model.namespaced),
    );
  const activeCount = rows.filter(isVisible).length;
  const isNative = native;
  const q = catalogQuery.trim().toLowerCase();
  const filtered = q
    ? rows.filter((m) =>
        `${m.id} ${m.displayName ?? ""} ${provider}`.toLowerCase().includes(q),
      )
    : rows;
  if (q && filtered.length === 0) return null;
  // Display-only: enabled models float to the top of each provider group so they
  // stay findable in long lists. The sort is stable, so the server order is kept
  // inside each partition, and this does not affect the picker order above
  // (visibility toggles still only filter).
  const sorted = filtered.toSorted(
    (a, b) => Number(!isVisible(a)) - Number(!isVisible(b)),
  );
  const visible = sorted.slice(0, shown);
  const remaining = filtered.length - visible.length;
  // An empty provider has nothing to send: keep both bulk buttons inert so we never PUT an
  // empty target list (the management API rejects it with 400).
  const hasRows = rows.length > 0;
  const allOn = !hasRows || rows.every(isVisible);
  const allOff = !hasRows || rows.every((m) => !isVisible(m));
  const bulkToggle = (enable: boolean) => {
    if (!hasRows) return;
    onBulkToggle(rows, enable);
  };
  return (
    <div key={provider} className="models-provider-card">
      <div
        className={`row group-head models-provider-head${isCollapsed ? "" : " open"}`}
      >
        <ProviderHeading
          group={group}
          activeCount={activeCount}
          isCollapsed={isCollapsed}
          catalogQuery={catalogQuery}
          onToggleCollapse={onToggleCollapse}
        />
        <ProviderSettings
          group={group}
          configured={configured}
          capOn={capOn}
          contextCapValue={contextCapValue}
          busy={busy}
          fetchingProvider={fetchingProvider}
          onFetchModels={onFetchModels}
          onAddCustom={onAddCustom}
          onToggleCap={onToggleCap}
          allOn={allOn}
          allOff={allOff}
          bulkToggle={bulkToggle}
        />
      </div>
      {!isCollapsed && (
        <div className="models-provider-body">
          {isNative && (
            <p className="muted text-label models-provider-hint">
              {t("models.nativeHint")}
            </p>
          )}
          {rows.length === 0 && (
            <EmptyProviderHint
              liveModels={liveModels}
              discovery={discovery}
              showFailureBadge={false}
            />
          )}
          {visible.map((m) => (
            <ModelCatalogRow
              key={m.namespaced}
              model={m}
              off={!isVisible(m)}
              selectedModelName={selectedModelName}
              busy={busy}
              onSelectModel={onSelectModel}
              onToggleVisibility={onToggleVisibility}
            />
          ))}
          {remaining > 0 && (
            <Button
              type="button"
              onClick={onShowMore}
              variant="ghost"
              size="sm"
              className="models-show-more"
            >
              {t("models.showMore", { n: remaining })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ModelCatalogRow({
  model: m,
  off,
  selectedModelName,
  busy,
  onSelectModel,
  onToggleVisibility,
}: Pick<
  ModelsProviderCardProps,
  "selectedModelName" | "busy" | "onSelectModel" | "onToggleVisibility"
> & {
  model: ModelRow;
  off: boolean;
}) {
  const t = useT();
  return (
    <div
      key={m.namespaced}
      className={`models-catalog-row${selectedModelName === m.namespaced ? " is-selected" : ""}`}
    >
      <Button
        type="button"
        variant="ghost"
        className="models-catalog-select"
        aria-label={t("models.workspace.inspect", {
          model: m.native ? m.id : m.namespaced,
        })}
        aria-pressed={selectedModelName === m.namespaced}
        aria-controls="model-inspector"
        onClick={(event) => {
          onSelectModel(m.namespaced, event.currentTarget);
        }}
      >
        <span className="models-catalog-identity">
          <span className="models-catalog-name">
            {m.displayName || modelLabel(m.id)}
          </span>
          <code>{m.native ? m.id : m.namespaced}</code>
        </span>
        <span className="models-catalog-modalities">
          {m.inputModalities?.length
            ? m.inputModalities.map((kind) => (
                <Badge key={kind} variant="outline">
                  {kind}
                </Badge>
              ))
            : t("models.workspace.unknown")}
        </span>
        <span className="models-catalog-context">
          {m.contextWindow
            ? fmtK(m.contextWindow)
            : t("models.workspace.unknown")}
        </span>
        <IconChevron width={14} height={14} aria-hidden="true" />
      </Button>
      <LibrarySwitch
        size="touch"
        checked={!off}
        onCheckedChange={() => onToggleVisibility(m, off)}
        disabled={busy}
        aria-label={m.native ? m.id : m.namespaced}
      />
    </div>
  );
}

function ProviderHeading({
  group,
  activeCount,
  isCollapsed,
  catalogQuery,
  onToggleCollapse,
}: Pick<
  ModelsProviderCardProps,
  "group" | "catalogQuery" | "onToggleCollapse"
> & { activeCount: number; isCollapsed: boolean }) {
  const t = useT();
  const {
    provider,
    rows,
    native: isNative,
    liveModels,
    discovery,
    clientHideReason,
    clientHideReasonLabel,
    clientHidden,
  } = group;
  const discoveryFailure =
    liveModels && discovery?.status === "failed" ? discovery : undefined;
  return (
    <Button
      type="button"
      variant="ghost"
      className="row models-provider-toggle"
      onClick={onToggleCollapse}
      aria-expanded={!isCollapsed}
      disabled={catalogQuery.trim().length > 0}
      style={{
        flex: 1,
        border: 0,
        background: "transparent",
        padding: 0,
        color: "inherit",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <IconChevron
        style={{
          width: 14,
          height: 14,
          color: "var(--muted)",
          transform: isCollapsed ? "none" : "rotate(90deg)",
          transition: "transform .12s",
        }}
      />
      <span className="text-body font-semibold">{provider}</span>
      {isNative && (
        <span className="models-chip muted mono text-caption">
          {t("models.nativeGroupLabel")}
        </span>
      )}
      {discoveryFailure && (
        <span
          className="badge badge-amber"
          role="status"
          title={discoveryFailureLabel(t, discoveryFailure)}
        >
          {t("models.discoveryFailedBadge")}
        </span>
      )}
      {clientHideReason && (
        <span
          className="badge badge-amber"
          role="status"
          title={clientHideReasonLabel ?? t("models.clientDegradedBadge")}
        >
          {clientHidden
            ? t("models.clientHiddenBadge")
            : t("models.clientDegradedBadge")}
        </span>
      )}
      <span className="muted mono text-label">
        {t("models.active", { active: activeCount, total: rows.length })}
      </span>
    </Button>
  );
}

function ProviderSettings({
  group,
  configured,
  capOn,
  contextCapValue,
  busy,
  fetchingProvider,
  onFetchModels,
  onAddCustom,
  onToggleCap,
  allOn,
  allOff,
  bulkToggle,
}: Pick<
  ModelsProviderCardProps,
  | "group"
  | "configured"
  | "capOn"
  | "contextCapValue"
  | "busy"
  | "fetchingProvider"
  | "onFetchModels"
  | "onAddCustom"
  | "onToggleCap"
> & {
  allOn: boolean;
  allOff: boolean;
  bulkToggle: (enable: boolean) => void;
}) {
  const t = useT();
  const { provider, native: isNative } = group;
  const canFetchModels =
    !isNative &&
    configured?.authMode !== "forward" &&
    configured?.disabled !== true;
  return (
    <Accordion className="models-provider-options">
      <AccordionItem value="settings">
        <AccordionTrigger>
          {t("models.workspace.providerSettings")}
        </AccordionTrigger>
        <AccordionContent>
          <div className="row models-provider-actions">
            {canFetchModels && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-caption"
                disabled={busy || fetchingProvider !== null}
                onClick={(e) => {
                  e.stopPropagation();
                  onFetchModels();
                }}
              >
                {fetchingProvider === provider ? (
                  <Spinner aria-hidden data-icon="inline-start" />
                ) : (
                  <RefreshCwIcon aria-hidden data-icon="inline-start" />
                )}
                {fetchingProvider === provider
                  ? t("pws.fetchingModels")
                  : t("pws.fetchModels")}
              </Button>
            )}
            {!isNative && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-caption"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddCustom();
                }}
                aria-label={t("models.customAdd")}
                aria-haspopup="dialog"
              >
                <PlusIcon aria-hidden data-icon="inline-start" />
                {t("models.customAdd")}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-caption"
              disabled={busy || allOn}
              onClick={() => bulkToggle(true)}
            >
              {t("models.allOn")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-caption"
              disabled={busy || allOff}
              onClick={() => bulkToggle(false)}
            >
              {t("models.allOff")}
            </Button>
            {!isNative && (
              <>
                <Switch
                  on={capOn}
                  onClick={onToggleCap}
                  disabled={busy}
                  label={t("models.capValue", {
                    value: fmtK(contextCapValue),
                  })}
                />
                <span className="muted mono text-label">
                  {t("models.capValue", { value: fmtK(contextCapValue) })}
                </span>
              </>
            )}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
