import { Activity } from "lucide-react";
import { TrafficRowCells } from "../../traffic-row";
import type { TrafficLogEntry } from "../../traffic-shared";
import { Notice } from "../../ui";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../primitives/empty";
import { Panel, PanelHeader } from "../primitives/panel";
import { Spinner } from "../primitives/spinner";
import { DataList, DataRow } from "../primitives/data-list";
import { Timestamp } from "../primitives/timestamp";

function requestTokens(entry: TrafficLogEntry): number | undefined {
  if (entry.usage)
    return (
      entry.usage.totalTokens ??
      entry.usage.inputTokens + entry.usage.outputTokens
    );
  return entry.totalTokens;
}

export function RequestActivityList({
  entries,
  locale,
  failed,
  loaded,
  labels,
}: {
  entries: readonly TrafficLogEntry[];
  locale: string;
  failed: boolean;
  loaded: boolean;
  labels: {
    title: string;
    loadError: string;
    loading: string;
    emptyTitle: string;
    empty: string;
    viewAll: string;
  };
}) {
  const titleId = "dash-traffic-title";
  return (
    <Panel
      titleId={titleId}
      className="panel pws-dashboard-section pws-dashboard-section--rate-limits"
    >
      <PanelHeader
        titleId={titleId}
        title={labels.title}
        actions={
          <a className="btn btn-ghost btn-sm" href="#verkeer">
            {labels.viewAll}
          </a>
        }
      />
      {failed ? <Notice tone="err">{labels.loadError}</Notice> : null}
      {entries.length > 0 ? (
        <DataList className="pws-dashboard-rows ocx-reveal-list">
          {entries.map((entry) => (
            <RequestActivityRow key={requestKey(entry)} entry={entry} locale={locale} />
          ))}
        </DataList>
      ) : !failed ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {loaded ? <Activity aria-hidden /> : <Spinner />}
            </EmptyMedia>
            <EmptyTitle>{loaded ? labels.emptyTitle : labels.loading}</EmptyTitle>
            {loaded ? <EmptyDescription>{labels.empty}</EmptyDescription> : null}
          </EmptyHeader>
          {loaded ? (
            <EmptyContent>
              <a className="btn btn-ghost btn-sm" href="#verkeer" aria-label={labels.title}>
                {labels.title}
              </a>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : null}
    </Panel>
  );
}

export function RequestActivityRow({
  entry,
  locale,
}: {
  entry: TrafficLogEntry;
  locale: string;
}) {
  return (
    <DataRow className="traffic-entry">
      <div className="traffic-entry-head traffic-entry-head--grid">
        <Timestamp
          value={entry.timestamp}
          locale={locale}
          className="traffic-col traffic-col--time traffic-time"
        />
        <TrafficRowCells entry={entry} locale={locale} tokens={requestTokens(entry)} />
      </div>
    </DataRow>
  );
}

function requestKey(entry: TrafficLogEntry): string {
  return entry.requestId ?? `${entry.timestamp}-${entry.provider}-${entry.model}`;
}
