import { TrafficRowCells } from "../../traffic-row";
import type { TrafficLogEntry } from "../../traffic-shared";
import { Notice } from "../../ui";
import { Button } from "../primitives/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "../primitives/empty";
import { SectionHeader } from "../primitives/section-header";

function requestTokens(entry: TrafficLogEntry): number | undefined {
  if (entry.usage)
    return (
      entry.usage.totalTokens ??
      entry.usage.inputTokens + entry.usage.outputTokens
    );
  return entry.totalTokens;
}

function formatTime(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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
        <div className="pws-dashboard-rows" style={{ gap: 0 }}>
          {entries.map((entry) => (
            <RequestActivityRow key={requestKey(entry)} entry={entry} locale={locale} />
          ))}
        </div>
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
    <div
      className="traffic-entry"
      style={{ borderBottom: "1px solid var(--border-soft)" }}
    >
      <div className="traffic-entry-head traffic-entry-head--grid">
        <span className="traffic-col traffic-col--time traffic-time">
          {formatTime(entry.timestamp, locale)}
        </span>
        <TrafficRowCells entry={entry} locale={locale} tokens={requestTokens(entry)} />
      </div>
    </div>
  );
}

function requestKey(entry: TrafficLogEntry): string {
  return (
    entry.requestId ?? `${entry.timestamp}-${entry.provider}-${entry.model}`
  );
}
