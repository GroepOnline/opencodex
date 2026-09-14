import { Server } from "lucide-react";
import { Notice } from "../../ui";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../primitives/empty";
import { ProgressTrack } from "../primitives/progress-track";
import { Panel, PanelHeader } from "../primitives/panel";
import { Spinner } from "../primitives/spinner";
import { DataList, DataRow } from "../primitives/data-list";

export interface ProviderUsageItem {
  provider: string;
  requests: number;
  shareRatio: number;
}

export function ProviderUsageList({
  providers,
  locale,
  failed,
  loaded,
  labels,
}: {
  providers: readonly ProviderUsageItem[];
  locale: string;
  failed: boolean;
  loaded: boolean;
  labels: {
    title: string;
    loadError: string;
    loading: string;
    emptyTitle?: string;
    empty: string;
    viewAll?: string;
    providersNav: string;
    requestOne: string;
    requests: (count: string) => string;
  };
}) {
  const titleId = "dash-providers-title";
  return (
    <Panel
      titleId={titleId}
      className="panel pws-dashboard-section pws-dashboard-section--recent"
    >
      <PanelHeader
        titleId={titleId}
        title={labels.title}
        actions={
          <a className="btn btn-ghost btn-sm" href="#leveranciers">
            {labels.viewAll ?? labels.providersNav}
          </a>
        }
      />
      {failed ? <Notice tone="err">{labels.loadError}</Notice> : null}
      {providers.length > 0 ? (
        <DataList className="pws-dashboard-rows ocx-reveal-list">
          {providers.map((provider) => {
            const sharePct = Number.isFinite(provider.shareRatio)
              ? Math.min(100, Math.max(0, provider.shareRatio * 100))
              : 0;
            return (
              <ProviderUsageRow
                key={provider.provider}
                provider={provider.provider}
                requestLabel={
                  provider.requests === 1
                    ? labels.requestOne
                    : labels.requests(provider.requests.toLocaleString(locale))
                }
                sharePct={sharePct}
              />
            );
          })}
        </DataList>
      ) : !failed ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {loaded ? <Server aria-hidden /> : <Spinner />}
            </EmptyMedia>
            <EmptyTitle>{loaded ? (labels.emptyTitle ?? labels.empty) : labels.loading}</EmptyTitle>
            {loaded ? <EmptyDescription>{labels.empty}</EmptyDescription> : null}
          </EmptyHeader>
          {loaded ? (
            <EmptyContent>
              <a
                className="btn btn-ghost btn-sm"
                href="#leveranciers"
                aria-label={labels.providersNav}
              >
                {labels.providersNav}
              </a>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : null}
    </Panel>
  );
}

export function ProviderUsageRow({
  provider,
  requestLabel,
  sharePct,
}: {
  provider: string;
  requestLabel: string;
  sharePct: number;
}) {
  return (
    <DataRow className="pws-dashboard-row">
      <span className="pws-dashboard-row-name">{provider}</span>
      <span className="pws-dashboard-row-count muted">{requestLabel}</span>
      <ProgressTrack value={sharePct} />
    </DataRow>
  );
}
