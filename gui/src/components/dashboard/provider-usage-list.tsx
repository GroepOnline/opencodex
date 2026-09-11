import { Notice } from "../../ui";
import { Button } from "../primitives/button";
import { DataList, DataRow } from "../primitives/data-list";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "../primitives/empty";
import { ProgressTrack } from "../primitives/progress-track";
import { SectionHeader } from "../primitives/section-header";

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
    empty: string;
    providersNav: string;
    requestOne: string;
    requests: (count: string) => string;
  };
}) {
  return (
    <section
      className="pws-dashboard-section pws-dashboard-section--recent"
      aria-label={labels.title}
    >
      <SectionHeader title={labels.title} />
      {failed ? <Notice tone="err">{labels.loadError}</Notice> : null}
      {providers.length > 0 ? (
        <DataList className="pws-dashboard-rows">
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
            <EmptyDescription>{loaded ? labels.empty : labels.loading}</EmptyDescription>
          </EmptyHeader>
          {loaded ? (
            <EmptyContent>
              <Button
                variant="outline"
                nativeButton={false}
                render={<a href="#leveranciers" aria-label={labels.providersNav} />}
              >
                {labels.providersNav}
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : null}
    </section>
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
