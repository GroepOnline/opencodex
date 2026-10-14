import type { Locale, TFn } from "../../../i18n/shared";
import { Panel, PanelHeader } from "../../../components/primitives/panel";
import { formatTokens } from "../../../format-tokens";
import { modelLabel } from "../../../model-display";
import type { UsageModel } from "../model/usage-report";
import ShareMeter from "./ShareMeter";
export default function UsageModelsTable({
  models,
  modelQuery,
  onModelQuery,
  locale,
  t,
}: {
  models: UsageModel[];
  modelQuery: string;
  onModelQuery: (query: string) => void;
  locale: Locale;
  t: TFn;
}) {
  const searchLabel = t("usage.search.models");
  const sectionLabel = t("usage.section.models");
  const titleId = "usage-models-title";
  const searchInput = (
    <input
      className="input"
      aria-label={searchLabel}
      placeholder={searchLabel}
      value={modelQuery}
      onChange={(event) => onModelQuery(event.target.value)}
    />
  );
  const table = (
    <div className="tbl-wrap usage-scroll">
      <table className="tbl">
        <thead>
          <tr>
            <th>{t("logs.col.model")}</th>
            <th>{t("logs.col.provider")}</th>
            <th className="num">{t("usage.col.requests")}</th>
            <th className="num">{t("usage.col.measured")}</th>
            <th className="num">{t("usage.col.tokens")}</th>
            <th>{t("usage.col.share")}</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={`${model.provider}/${model.model}`}>
              <td className="mono">{modelLabel(model.model)}</td>
              <td className="muted">{model.provider}</td>
              <td className="num">{model.requests}</td>
              <td className="num">{model.measuredRequests}</td>
              <td className="num mono">
                {formatTokens(model.totalTokens, locale)}
              </td>
              <td>
                <ShareMeter ratio={model.shareRatio} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <Panel titleId={titleId} style={{ marginTop: 16 }}>
      <PanelHeader
        titleId={titleId}
        title={sectionLabel}
        actions={searchInput}
      />
      {table}
    </Panel>
  );
}
