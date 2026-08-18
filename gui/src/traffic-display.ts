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

/** Local calendar day key — matches server usage bucketing and row timestamps in the browser TZ. */
export function localTrafficDateKey(ts = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
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
  formatModel: (model: string) => string = value => value,
): string {
  const providerKnown = !isUnknownTrafficLabel(row.provider);
  const modelKnown = !isUnknownTrafficLabel(row.model);
  if (!providerKnown && !modelKnown) return t("common.unknown");
  if (providerKnown && modelKnown) return `${row.provider.trim()}/${formatModel(row.model)}`;
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
