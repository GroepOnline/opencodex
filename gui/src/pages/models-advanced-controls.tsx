import type { Dispatch, SetStateAction } from "react";
import { Switch, Select, Tooltip } from "../ui";
import { Button } from "../components/primitives/button";
import { IconInfo } from "../icons";
import { useT, type TKey, type TFn } from "../i18n/shared";
import {
  CAP_OPTION_SET,
  CAP_OPTIONS,
  CUSTOM_OPTION,
  fmtK,
  THREAD_OPTION_SET,
  THREAD_OPTIONS,
  type ShadowCallData,
  type V2Status,
  type ModelRow,
} from "./models-shared";

type ShadowControlsProps = {
  shadowCall: ShadowCallData | null;
  shadowCallSaving: boolean;
  shadowModelOptions: { value: string; label: string }[];
  saveShadowCall: (patch: Partial<ShadowCallData>) => Promise<void>;
  setShadowCall: Dispatch<SetStateAction<ShadowCallData | null>>;
};

type AgentModeControlsProps = {
  v2: V2Status | null;
  v2Busy: boolean;
  setMultiAgentMode: (mode: "v1" | "default" | "v2") => Promise<void>;
  setV2HelpOpen: (open: boolean) => void;
};

type ThreadControlsProps = {
  v2: V2Status | null;
  v2Busy: boolean;
  v2Note: string;
  showThreadsCustom: boolean;
  threadsCustom: string;
  setThreadsCustom: (value: string) => void;
  onSelectThreads: (value: string) => void;
  putV2Threads: (value: number) => Promise<void>;
};

type ContextCapControlsProps = {
  contextCapValue: number;
  showCustom: boolean;
  customCap: string;
  setCustomCap: (value: string) => void;
  busy: boolean;
  onSelectCap: (value: string) => void;
  applyCustomCap: () => void;
  allCapped: boolean;
  setAll: () => void;
};
type ModelsAdvancedControlsProps = ShadowControlsProps &
  AgentModeControlsProps &
  ThreadControlsProps &
  ContextCapControlsProps & { models: ModelRow[] };
export function ModelsShadowControls({
  shadowCall,
  shadowCallSaving,
  shadowModelOptions,
  saveShadowCall,
  setShadowCall,
}: ShadowControlsProps) {
  const t = useT();
  return (
    <>
      <div
        className="models-shadow-row row muted text-control"
        aria-busy={!shadowCall || undefined}
      >
        <span className="models-shadow-label">
          {t("models.shadowCallIntercept")}{" "}
          <Tooltip
            content={t("models.shadowCallInterceptHint")}
            side="top"
            maxWidth={320}
          >
            <span
              style={{ cursor: "help" }}
              aria-label={t("models.shadowCallInterceptHint")}
            >
              ⓘ
            </span>
          </Tooltip>
        </span>
        <code
          className="text-caption models-shadow-warning"
          style={{ opacity: 0.6 }}
        >
          {t("models.shadowCallOriginal")}
        </code>
        <Switch
          on={shadowCall?.enabled ?? false}
          onClick={() => void saveShadowCall({ enabled: !shadowCall?.enabled })}
          disabled={!shadowCall || shadowCallSaving}
          label={t("models.shadowCallIntercept")}
        />
        <div className="models-shadow-model-slot">
          <Select
            value={shadowCall?.model ?? ""}
            options={[{ value: "", label: "\u2014" }, ...shadowModelOptions]}
            onChange={(v) => {
              setShadowCall((c) => (c ? { ...c, model: v } : c));
              void saveShadowCall({ model: v });
            }}
            disabled={!shadowCall || shadowCallSaving || !shadowCall.enabled}
            label={t("models.shadowCallIntercept")}
          />
        </div>
      </div>
    </>
  );
}

function AgentModeControls({
  v2,
  v2Busy,
  setMultiAgentMode,
  setV2HelpOpen,
}: AgentModeControlsProps) {
  const t = useT();
  return (
    <>
      {v2 && (
        <div className="models-v2-mode-row row">
          <span className="muted text-control">{t("models.v2Label")}</span>
          <div
            className="segmented models-segmented"
            role="radiogroup"
            aria-label={t("models.v2Label")}
          >
            {(["v1", "default", "v2"] as const).map((mode) => (
              <Button
                key={mode}
                type="button"
                role="radio"
                aria-checked={(v2.multiAgentMode ?? "default") === mode}
                className={`btn btn-sm${(v2.multiAgentMode ?? "default") === mode ? " btn-primary" : " btn-ghost"}`}
                style={{
                  background:
                    (v2.multiAgentMode ?? "default") === mode
                      ? undefined
                      : "transparent",
                  color:
                    (v2.multiAgentMode ?? "default") === mode
                      ? undefined
                      : "var(--muted)",
                }}
                disabled={v2Busy}
                onClick={() => void setMultiAgentMode(mode)}
              >
                {t(`models.v2Mode_${mode}` as TKey)}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className=""
            style={{
              width: 24,
              height: 24,
              minWidth: 24,
              flex: "0 0 24px",
              padding: 0,
              borderRadius: "var(--radius-pill)",
              color: "var(--muted)",
            }}
            onClick={() => setV2HelpOpen(true)}
            aria-label={t("models.v2Label")}
            aria-haspopup="dialog"
          >
            <IconInfo width={15} height={15} aria-hidden="true" />
          </Button>
        </div>
      )}
    </>
  );
}

function ThreadControls({
  v2,
  v2Busy,
  v2Note,
  showThreadsCustom,
  threadsCustom,
  setThreadsCustom,
  onSelectThreads,
  putV2Threads,
}: ThreadControlsProps) {
  const t = useT();
  return (
    <>
      {v2 && (v2.enabled || v2.agentsMaxThreadsConflict || v2Note) && (
        <div className="models-v2-detail-row row">
          {v2.enabled && (
            <>
              <span className="muted text-control">
                {t("models.v2ThreadsLabel")}
              </span>
              <Select
                value={threadSelectValue(v2, showThreadsCustom)}
                options={threadSelectOptions(v2, showThreadsCustom, t)}
                onChange={(v) => onSelectThreads(v)}
                disabled={v2Busy}
                label={t("models.v2ThreadsLabel")}
              />
              {showThreadsCustom && (
                <>
                  <input
                    className="input"
                    style={{ width: 100 }}
                    inputMode="numeric"
                    value={threadsCustom}
                    onChange={(e) => setThreadsCustom(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        void putV2Threads(
                          Number(threadsCustom.replace(/[_,\s]/g, "")),
                        );
                    }}
                    disabled={v2Busy}
                    aria-label={t("models.v2ThreadsLabel")}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={v2Busy}
                    onClick={() => {
                      void putV2Threads(
                        Number(threadsCustom.replace(/[_,\s]/g, "")),
                      );
                    }}
                  >
                    {t("models.v2ThreadsApply")}
                  </Button>
                </>
              )}
            </>
          )}
          {v2.enabled && v2.agentsMaxThreadsConflict && (
            <span className="mono text-label" style={{ color: "var(--red)" }}>
              {t("models.v2Conflict")}
            </span>
          )}
          {v2Note && <span className="muted text-label">{v2Note}</span>}
        </div>
      )}
    </>
  );
}

function ContextCapControls({
  contextCapValue,
  showCustom,
  customCap,
  setCustomCap,
  busy,
  onSelectCap,
  applyCustomCap,
  allCapped,
  setAll,
}: ContextCapControlsProps) {
  const t = useT();
  return (
    <>
      <div className="row models-cap-row">
        <span className="muted text-control">
          {t("models.contextCapLabel")}
        </span>
        <Select
          value={
            showCustom
              ? CUSTOM_OPTION
              : CAP_OPTION_SET.has(contextCapValue)
                ? String(contextCapValue)
                : CUSTOM_OPTION
          }
          options={[
            ...(!CAP_OPTION_SET.has(contextCapValue) && !showCustom
              ? [
                  {
                    value: String(contextCapValue),
                    label: fmtK(contextCapValue),
                  },
                ]
              : []),
            ...CAP_OPTIONS.map((v) => ({ value: String(v), label: fmtK(v) })),
            { value: CUSTOM_OPTION, label: t("models.custom") },
          ]}
          onChange={(v) => onSelectCap(v)}
          disabled={busy}
          label={t("models.contextCapLabel")}
        />
        {showCustom && (
          <>
            <input
              className="input"
              style={{ width: 160 }}
              inputMode="numeric"
              placeholder={t("models.customPlaceholder")}
              value={customCap}
              onChange={(e) => setCustomCap(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyCustomCap();
              }}
              disabled={busy}
              aria-label={t("models.customPlaceholder")}
            />
            <Button
              type="button"
              onClick={applyCustomCap}
              disabled={busy}
              variant="ghost"
              size="sm"
              className=""
            >
              {t("models.customApply")}
            </Button>
          </>
        )}
        <Switch
          on={allCapped}
          onClick={setAll}
          disabled={busy}
          label={t("models.setAll")}
        />
        <span className="muted text-label leading-body">
          {t("models.setAllHint", { value: fmtK(contextCapValue) })}
        </span>
      </div>
    </>
  );
}

export function ModelsAdvancedControls(props: ModelsAdvancedControlsProps) {
  const t = useT();
  const { models } = props;
  return (
    <>
      <div className="models-control-top-row">
        <ModelsShadowControls {...props} />
        <AgentModeControls {...props} />
      </div>
      <ThreadControls {...props} />
      <ContextCapControls {...props} />

      {(() => {
        const customCount = models.filter((m) => m.custom).length;
        if (customCount === 0) return null;
        return (
          <div className="row muted text-label models-custom-summary">
            <span className="models-chip mono text-caption">
              {t("models.customSummary", { count: customCount })}
            </span>
          </div>
        );
      })()}

      <div className="row muted text-label leading-body models-order-hint">
        <IconInfo width={15} height={15} aria-hidden="true" />
        <span>{t("models.orderHint")}</span>
      </div>
    </>
  );
}

function threadSelectValue(v2: V2Status, showThreadsCustom: boolean) {
  return showThreadsCustom
    ? CUSTOM_OPTION
    : v2.maxConcurrentThreadsPerSession !== null &&
        v2.maxConcurrentThreadsPerSession !== undefined
      ? THREAD_OPTION_SET.has(v2.maxConcurrentThreadsPerSession)
        ? String(v2.maxConcurrentThreadsPerSession)
        : CUSTOM_OPTION
      : "";
}
function threadSelectOptions(v2: V2Status, showThreadsCustom: boolean, t: TFn) {
  return [
    ...(v2.maxConcurrentThreadsPerSession === null ||
    v2.maxConcurrentThreadsPerSession === undefined
      ? [{ value: "", label: t("models.v2ThreadsDefault") }]
      : []),
    ...(v2.maxConcurrentThreadsPerSession !== null &&
    v2.maxConcurrentThreadsPerSession !== undefined &&
    !THREAD_OPTION_SET.has(v2.maxConcurrentThreadsPerSession) &&
    !showThreadsCustom
      ? [
          {
            value: CUSTOM_OPTION,
            label: String(v2.maxConcurrentThreadsPerSession),
          },
        ]
      : []),
    ...THREAD_OPTIONS.map((v) => ({
      value: String(v),
      label: String(v),
    })),
    { value: CUSTOM_OPTION, label: t("models.custom") },
  ];
}
