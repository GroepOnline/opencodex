import type { ReactNode } from "react";
import type { TKey } from "./i18n/shared";

const UNKNOWN_SENTINEL = "unknown";

export interface TrafficLogRow {
  timestamp: number;
  model: string;
  provider: string;
  principal?: string;
  account?: string;
  status: number;
  durationMs?: number;
}

export function isUnknownTrafficLabel(value: string | undefined): boolean {
  return !value?.trim() || value.trim().toLowerCase() === UNKNOWN_SENTINEL;
}

/** UTC calendar day key — the explicit timezone shared with server usage bucketing. */
export function localTrafficDateKey(ts = Date.now()): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function countTrafficRowsOnDay(rows: readonly { timestamp: number }[], dayKey: string): number {
  return rows.filter(row => localTrafficDateKey(row.timestamp) === dayKey).length;
}

export function resolveRequestsToday(
  summaryDays: ReadonlyArray<{ date: string; requests: number }> | undefined,
  rows: readonly { timestamp: number }[],
): number {
  const key = localTrafficDateKey();
  const fromSummary = summaryDays?.find(day => day.date === key)?.requests ?? 0;
  const fromRows = countTrafficRowsOnDay(rows, key);
  return Math.max(fromSummary, fromRows);
}

export function formatTrafficLabel(
  value: string | undefined,
  t: (key: TKey) => string,
): string {
  return isUnknownTrafficLabel(value) ? t("common.unknown") : value!.trim();
}

/** Principal column: apiKeys[].name, else configured provider id, else account suffix. */
export function trafficPrincipalLabel(
  row: Pick<TrafficLogRow, "principal" | "account" | "provider">,
  t: (key: TKey) => string,
): string {
  if (row.principal?.trim()) return row.principal.trim();
  if (!isUnknownTrafficLabel(row.provider)) return row.provider.trim();
  if (row.account?.trim()) return row.account.trim();
  return t("common.unknown");
}

/** Provider/model column — `provider/model` when both known. */
export function trafficProviderModelLabel(
  row: Pick<TrafficLogRow, "model" | "provider">,
  t: (key: TKey) => string,
  formatModel: (model: string) => ReactNode = value => value,
): ReactNode {
  const providerKnown = !isUnknownTrafficLabel(row.provider);
  const modelKnown = !isUnknownTrafficLabel(row.model);
  if (!providerKnown && !modelKnown) return t("common.unknown");
  if (providerKnown && modelKnown) {
      const model = row.model.trim();
      if (model.toLowerCase().startsWith(`${row.provider.trim().toLowerCase()}/`)) return formatModel(model);
      return <>{row.provider.trim()}/{formatModel(model)}</>;
    }
  if (providerKnown) return row.provider.trim();
  return formatModel(row.model);
}

export function trafficModelLabel(
  row: Pick<TrafficLogRow, "model">,
  t: (key: TKey) => string,
): string {
  return formatTrafficLabel(row.model, t);
}

export function trafficFilterLabel(
  provider: string,
  t: (key: TKey) => string,
): string {
  return formatTrafficLabel(provider, t);
}
