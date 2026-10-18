import type { Locale, TFn } from "../../../i18n/shared";
import { Panel, PanelHeader } from "../../../components/primitives/panel";
import { formatTokens } from "../../../format-tokens";
import type { UsageProvider } from "../model/usage-report";
import ShareMeter from "./ShareMeter";
export default function UsageProvidersTable({
  providers,
  locale,
  t,
}: {
  providers: UsageProvider[];
  locale: Locale;
  t: TFn;
}) {
  const sectionLabel = t("usage.section.providers");
  const titleId = "usage-providers-title";
  const table = (
    <div className="tbl-wrap usage-scroll">
      <table className="tbl">
        <thead>
          <tr>
            <th>{t("logs.col.provider")}</th>
            <th className="num">{t("usage.col.requests")}</th>
            <th className="num">{t("usage.col.measured")}</th>
            <th className="num">{t("usage.col.tokens")}</th>
            <th>{t("usage.col.share")}</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => (
            <tr key={provider.provider}>
              <td className="mono">{provider.provider}</td>
              <td className="num">{provider.requests}</td>
              <td className="num">{provider.measuredRequests}</td>
              <td className="num mono">
                {formatTokens(provider.totalTokens, locale)}
              </td>
              <td>
                <ShareMeter ratio={provider.shareRatio} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <Panel titleId={titleId} style={{ marginTop: 16 }}>
      <PanelHeader titleId={titleId} title={sectionLabel} />
      {table}
    </Panel>
  );
}
