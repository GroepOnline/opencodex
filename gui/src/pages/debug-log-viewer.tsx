import { Bug } from "lucide-react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useI18n } from "../i18n/shared";
import type { DebugLogEntry, LogStream } from "./debug-shared";
import { formatLogTime } from "./debug-shared";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/primitives/empty";

export function DebugLogViewer({
  debug,
  stream,
  streamEnabled,
  entries,
  scrollContainerRef,
  lineVirtualizer,
}: {
  debug: boolean;
  stream: LogStream;
  streamEnabled: boolean;
  entries: DebugLogEntry[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  lineVirtualizer: Virtualizer<HTMLDivElement, Element>;
}) {
  const { t } = useI18n();

  if (!debug) return null;

  if (!streamEnabled) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bug aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{t("debug.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("debug.empty")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (entries.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bug aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{t("debug.noLinesTitle")}</EmptyTitle>
          <EmptyDescription>{t(`debug.noLines.${stream}`)}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      className="log-detail-json debug-log-viewer"
    >
      <div
        className="debug-log-virtual"
        style={{
          position: "relative",
          height: lineVirtualizer.getTotalSize(),
          width: "100%",
        }}
      >
        {lineVirtualizer.getVirtualItems().map(virtualRow => (
          <div
            key={virtualRow.key}
            ref={lineVirtualizer.measureElement}
            data-index={virtualRow.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            {`${formatLogTime(entries[virtualRow.index]!.at)}${entries[virtualRow.index]!.line}`}
          </div>
        ))}
      </div>
    </div>
  );
}
