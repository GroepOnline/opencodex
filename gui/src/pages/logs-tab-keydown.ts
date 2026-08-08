import type { KeyboardEvent } from "react";

export type LogsTab = "logs" | "debug";

export function readTabFromHash(): LogsTab {
  // New IA hashes (#verkeer/debug); legacy #logs/debug still resolves here too.
  return window.location.hash.replace(/^#\/?/, "") === "verkeer/debug" ? "debug" : "logs";
}

export function selectLogsTab(next: LogsTab) {
  window.location.hash = next === "debug" ? "verkeer/debug" : "verkeer/logs";
}

export function logsTabKeyDown(e: KeyboardEvent) {
  if (e.key === "ArrowLeft" || e.key === "Home") {
    e.preventDefault();
    selectLogsTab("logs");
    document.getElementById("logs-tab-logs")?.focus();
  } else if (e.key === "ArrowRight" || e.key === "End") {
    e.preventDefault();
    selectLogsTab("debug");
    document.getElementById("logs-tab-debug")?.focus();
  }
}
