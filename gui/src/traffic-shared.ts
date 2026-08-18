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

/**
 * Creates a date key using the local calendar date.
 *
 * @param when - The date to format; defaults to the current date
 * @returns The date in `YYYY-MM-DD` format
 */
export function localCalendarDayKey(when = new Date()): string {
  const y = when.getFullYear();
  const m = String(when.getMonth() + 1).padStart(2, "0");
  const d = String(when.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Determines whether a traffic label is missing, blank, or set to `"unknown"`.
 *
 * @param value - The traffic label to inspect
 * @returns `true` if the label is missing, blank, or equals `"unknown"` ignoring case, `false` otherwise.
 */
export function isUnknownTrafficLabel(value: string | undefined): boolean {
  return !value?.trim() || value.trim().toLowerCase() === UNKNOWN;
}

/**
 * Builds a display label from a traffic entry's provider and model.
 *
 * @param entry - The traffic record containing provider and model identifiers
 * @returns The provider/model label, the model label when the provider is unknown, or `null` when no usable model is available
 */
export function trafficProviderModelLabel(entry: TrafficLogEntry): string | null {
  const model = entry.resolvedModel
    ?? (isUnknownTrafficLabel(entry.model) ? entry.requestedModel : entry.model);
  if (isUnknownTrafficLabel(model)) return null;
  const provider = entry.provider?.trim();
  if (isUnknownTrafficLabel(provider)) return model!.trim();
  return `${provider}/${model!.trim()}`;
}

/**
 * Resolves the display label for a traffic entry's account or provider.
 *
 * @param entry - The traffic record containing account and provider identifiers
 * @param t - Translates the label used for unknown providers
 * @returns The account, recognized provider suffix, provider name, or localized unknown label
 */
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

/**
 * Counts traffic log entries recorded on a specified local calendar day.
 *
 * @param logs - The traffic log entries to inspect
 * @param dayKey - The day to match in `YYYY-MM-DD` format
 * @returns The number of entries recorded on the specified day
 */
export function countRequestsOnDay(logs: readonly TrafficLogEntry[], dayKey: string): number {
  let count = 0;
  for (const entry of logs) {
    if (localCalendarDayKey(new Date(entry.timestamp)) === dayKey) count += 1;
  }
  return count;
}

/**
 * Computes the number of requests recorded for the current local calendar day.
 *
 * @param logs - Recent traffic log entries
 * @param summaryDays - Persisted daily request counts
 * @returns The greater of the live log count and persisted summary count for today
 */
export function requestsTodayCount(
  logs: readonly TrafficLogEntry[],
  summaryDays?: Array<{ date: string; requests: number }>,
): number {
  const key = localCalendarDayKey();
  const liveCount = countRequestsOnDay(logs, key);
  const summaryCount = summaryDays?.find(day => day.date === key)?.requests ?? 0;
  // The live endpoint is a bounded tail; the persisted summary is authoritative.
  return Math.max(liveCount, summaryCount);
}

/**
 * Provides a localized label for a traffic entry's response status.
 *
 * @param entry - The traffic entry whose status determines the label
 * @param locale - The locale used for status-code descriptions
 * @param t - The translation function for completed, error, and busy labels
 * @returns The localized status label
 */
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

/**
 * Determines the CSS class for a traffic entry's status.
 *
 * @param entry - The traffic entry whose status determines the class
 * @returns A success class for 2xx statuses, an error class for HTTP errors or status `0`, or an empty string otherwise
 */
export function trafficStatusClass(entry: TrafficLogEntry): string {
  if (entry.status >= 200 && entry.status < 300) return "stempel--klaar";
  if (entry.status >= 400 || entry.status === 0) return "stempel--fout";
  return "";
}
