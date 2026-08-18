import type { TFn } from "./i18n/shared";
import { statusCodeInfo } from "./status-codes";

export interface TrafficLogEntry {
  requestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  account?: string;
  resolvedModel?: string;
  requestedModel?: string;
  status: number;
  durationMs: number;
  errorCode?: string;
  upstreamError?: string;
  totalTokens?: number;
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number };
}

const UNKNOWN = "unknown";
const CODEX_ACCOUNT_SUFFIX_RE = /^p[0-9a-f]{6}$/i;

/** Local calendar day key — matches server usage summary bucketing, not UTC ISO dates. */
export function localCalendarDayKey(when = new Date()): string {
  const y = when.getFullYear();
  const m = String(when.getMonth() + 1).padStart(2, "0");
  const d = String(when.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isUnknownTrafficLabel(value: string | undefined): boolean {
  return !value?.trim() || value.trim().toLowerCase() === UNKNOWN;
}

export function trafficProviderModelLabel(entry: TrafficLogEntry): string | null {
  const model = entry.resolvedModel
    ?? (isUnknownTrafficLabel(entry.model) ? entry.requestedModel : entry.model);
  if (isUnknownTrafficLabel(model)) return null;
  return model!.trim();
}

export function trafficPrincipalLabel(entry: TrafficLogEntry, t: TFn): string {
  if (entry.account?.trim()) return entry.account.trim();
  const provider = entry.provider?.trim();
  if (isUnknownTrafficLabel(provider)) return t("vk.unknown");
  const cut = provider!.lastIndexOf("-");
  if (cut > 0) {
    const suffix = provider!.slice(cut + 1);
    if (suffix === "main" || CODEX_ACCOUNT_SUFFIX_RE.test(suffix)) return suffix;
  }
  return provider!;
}

export function countRequestsOnDay(logs: readonly TrafficLogEntry[], dayKey: string): number {
  let count = 0;
  for (const entry of logs) {
    if (localCalendarDayKey(new Date(entry.timestamp)) === dayKey) count += 1;
  }
  return count;
}

/** Prefer the live tail when loaded — it includes errors and matches local timestamps. */
export function requestsTodayCount(
  logs: readonly TrafficLogEntry[],
  summaryDays?: Array<{ date: string; requests: number }>,
): number {
  const key = localCalendarDayKey();
  if (logs.length > 0) return countRequestsOnDay(logs, key);
  return summaryDays?.find(day => day.date === key)?.requests ?? 0;
}

export function trafficStatusLabel(
  entry: TrafficLogEntry,
  locale: string,
  t: (key: "vk.stampDone" | "vk.stampError" | "vk.stampBusy") => string,
): string {
  if (entry.status >= 200 && entry.status < 300) return t("vk.stampDone");
  const info = statusCodeInfo(entry.status, locale);
  if (info?.label) return info.label;
  if (entry.status === 0) return t("vk.stampError");
  if (entry.status >= 400) return t("vk.stampError");
  return t("vk.stampBusy");
}

export function trafficStatusClass(entry: TrafficLogEntry): string {
  if (entry.status >= 200 && entry.status < 300) return "stempel--klaar";
  if (entry.status >= 400 || entry.status === 0) return "stempel--fout";
  return "";
}
