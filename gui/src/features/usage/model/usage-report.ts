export type Range = "all" | "30d" | "7d";
export type UsageSurface = "all" | "codex" | "claude" | "grok";

export function usagePayloadKey(
  apiBase: string,
  range: Range,
  surface: UsageSurface,
): string {
  return `${apiBase}:${range}:${surface}`;
}

export interface UsageSummaryTotals {
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  unreportedRequests: number;
  unsupportedRequests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  coverageRatio: number;
  estimatedCostUsd?: number;
  pricedRequests?: number;
  unpricedRequests?: number;
  unmeteredRequests?: number;
  p95LatencyMs?: number;
  p95TtftMs?: number;
  cacheReadRatio?: number;
  ratio429?: number;
  ratio502?: number;
}

export interface UsageDay {
  date: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  totalTokens: number;
  models: UsageDayModel[];
}

export interface UsageDayModel {
  model: string;
  provider: string;
  requests: number;
  totalTokens: number;
}

export interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
}

export interface UsageProvider {
  provider: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  shareRatio: number;
}

export interface UsageResponse {
  range: Range;
  surface: UsageSurface;
  since: number | null;
  generatedAt: number;
  summary: UsageSummaryTotals;
  days: UsageDay[];
  models: UsageModel[];
  providers: UsageProvider[];
  error?: string;
}

export function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

// Stable per-model bar color: hash the provider/model id to a hue so the same model keeps its color
// across days and renders. Saturation/lightness are fixed for a cohesive palette on the dark chart.
export function modelColor(model: string, provider: string): string {
  const key = `${provider}/${model}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 55%)`;
}

// Last 7 calendar days (oldest → newest), zero-filled, for the 7d bar chart. The API's `days` only
// carries dates with activity, so missing days are backfilled to 0 to keep a stable 7-bar axis.
export function lastSevenDays(days: UsageDay[]): UsageDay[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const out: UsageDay[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - 6);
  for (let i = 0; i < 7; i++) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    const d = byDate.get(iso);
    out.push({
      date: iso,
      requests: d?.requests ?? 0,
      measuredRequests: d?.measuredRequests ?? 0,
      reportedRequests: d?.reportedRequests ?? 0,
      totalTokens: d?.totalTokens ?? 0,
      models: d?.models ?? [],
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

export function quantileBuckets(values: number[]): number[] {
  const positive = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (positive.length === 0) return [0, 0, 0, 0];
  const q = (p: number) =>
    positive[Math.min(positive.length - 1, Math.floor(p * positive.length))];
  return [q(0.25), q(0.5), q(0.75), q(0.95)];
}

export function bucketLevel(value: number, buckets: number[]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (value <= buckets[0]) return 1;
  if (value <= buckets[1]) return 2;
  if (value <= buckets[2]) return 3;
  return 4;
}

export interface HeatmapCell {
  date: string;
  requests: number;
  totalTokens: number;
  level: 0 | 1 | 2 | 3 | 4;
  dayOfWeek: number;
}

export function buildHeatmap(days: UsageDay[]): {
  weeks: HeatmapCell[][];
  months: { label: string; col: number }[];
  buckets: number[];
} {
  const buckets = quantileBuckets(days.map((d) => d.totalTokens));
  const dayMap = new Map(days.map((d) => [d.date, d]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  // Align to Sunday
  start.setDate(start.getDate() - start.getDay());

  const weeks: HeatmapCell[][] = [];
  const months: { label: string; col: number }[] = [];
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  let lastMonthCol = -4;
  let prevMonthIdx = -1;
  let week: HeatmapCell[] = [];
  const cursor = new Date(start);

  while (cursor <= today) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    const m = cursor.getMonth();
    if (
      cursor.getDay() === 0 &&
      m !== prevMonthIdx &&
      weeks.length - lastMonthCol >= 4
    ) {
      months.push({ label: monthNames[m], col: weeks.length });
      lastMonthCol = weeks.length;
      prevMonthIdx = m;
    }
    const d = dayMap.get(iso);
    week.push({
      date: iso,
      requests: d?.requests ?? 0,
      totalTokens: d?.totalTokens ?? 0,
      level: d ? bucketLevel(d.totalTokens, buckets) : 0,
      dayOfWeek: cursor.getDay(),
    });
    if (cursor.getDay() === 6) {
      weeks.push(week);
      week = [];
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  if (week.length > 0) {
    while (week.length < 7) {
      week.push({
        date: "",
        requests: 0,
        totalTokens: 0,
        level: 0,
        dayOfWeek: week.length,
      });
    }
    weeks.push(week);
  }
  return { weeks, months, buckets };
}
