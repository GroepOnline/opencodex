import { TrafficRowCells } from "../../traffic-row";
import type { TrafficLogEntry } from "../../traffic-shared";
import { Notice } from "../../ui";
import { Button } from "../primitives/button";
import { DataList, DataRow } from "../primitives/data-list";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "../primitives/empty";
import { SectionHeader } from "../primitives/section-header";
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
    empty: string;
  };
}) {
  return (
    <section
      className="pws-dashboard-section pws-dashboard-section--rate-limits"
      aria-label={labels.title}
    >
      <SectionHeader title={labels.title} />
      {failed ? <Notice tone="err">{labels.loadError}</Notice> : null}
      {entries.length > 0 ? (
        <DataList className="pws-dashboard-rows" style={{ gap: 0 }}>
          {entries.map((entry) => (
            <RequestActivityRow key={requestKey(entry)} entry={entry} locale={locale} />
          ))}
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
                render={<a href="#verkeer" aria-label={labels.title} />}
              >
                {labels.title}
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : null}
    </section>
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
    <DataRow
      className="traffic-entry"
      style={{ borderBottom: "1px solid var(--border-soft)" }}
    >
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
