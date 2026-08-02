import type { OcxUsage } from "../types";
import { getActiveTurnCount, isDraining } from "../server/lifecycle";

export const REQUEST_DURATION_BUCKETS_MS = [
  25,
  50,
  100,
  250,
  500,
  1_000,
  2_500,
  5_000,
  10_000,
  30_000,
  60_000,
  120_000,
] as const;

export const FIRST_OUTPUT_BUCKETS_MS = [
  25,
  50,
  100,
  250,
  500,
  1_000,
  2_500,
  5_000,
  10_000,
  30_000,
  60_000,
] as const;

export type MetricSurface = "codex" | "claude" | "claude-desktop" | "grok" | "unknown";
export type MetricStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "unknown";
export type MetricTerminalStatus = "completed" | "incomplete" | "failed" | "none";
export type MetricTokenType = "input" | "output" | "cache_read" | "cache_write" | "reasoning_output";

export interface RequestMetricObservation {
  surface?: "claude" | "claude-desktop" | "grok";
  status: number;
  durationMs: number;
  firstOutputMs?: number;
  terminalStatus?: "completed" | "incomplete" | "failed";
  usage?: OcxUsage;
}

export interface ProcessMetricsSnapshot {
  uptimeSeconds: number;
  residentMemoryBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalMemoryBytes: number;
  arrayBuffersBytes: number;
  activeTurns: number;
  draining: boolean;
}

export interface MetricsSnapshot {
  version: 1;
  generatedAt: number;
  process: ProcessMetricsSnapshot;
  requests: Array<{
    surface: MetricSurface;
    statusClass: MetricStatusClass;
    terminalStatus: MetricTerminalStatus;
    count: number;
  }>;
  requestDurationMs: Array<HistogramSnapshot>;
  firstOutputMs: Array<HistogramSnapshot>;
  tokens: Array<{
    surface: MetricSurface;
    type: MetricTokenType;
    count: number;
  }>;
}

export interface HistogramSnapshot {
  surface: MetricSurface;
  buckets: Array<{ le: number; count: number }>;
  count: number;
  sum: number;
}

interface HistogramState {
  counts: number[];
  count: number;
  sum: number;
}

interface RequestCounterState {
  surface: MetricSurface;
  statusClass: MetricStatusClass;
  terminalStatus: MetricTerminalStatus;
  count: number;
}

interface TokenCounterState {
  surface: MetricSurface;
  type: MetricTokenType;
  count: number;
}

const SURFACE_ORDER: readonly MetricSurface[] = ["codex", "claude", "claude-desktop", "grok", "unknown"];
const STATUS_ORDER: readonly MetricStatusClass[] = ["1xx", "2xx", "3xx", "4xx", "5xx", "unknown"];
const TERMINAL_ORDER: readonly MetricTerminalStatus[] = ["completed", "incomplete", "failed", "none"];
const TOKEN_ORDER: readonly MetricTokenType[] = ["input", "output", "cache_read", "cache_write", "reasoning_output"];

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function counterValue(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(nonNegativeFinite(value)));
}

function addCounter(current: number, amount: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + counterValue(amount));
}

function addSum(current: number, amount: number): number {
  const next = current + nonNegativeFinite(amount);
  return Number.isFinite(next) ? next : Number.MAX_VALUE;
}

export function metricSurface(surface: RequestMetricObservation["surface"] | unknown): MetricSurface {
  switch (surface) {
    case undefined:
    case null:
      return "codex";
    case "claude":
    case "claude-desktop":
    case "grok":
      return surface;
    default:
      return "unknown";
  }
}

export function metricStatusClass(status: number): MetricStatusClass {
  if (!Number.isInteger(status)) return "unknown";
  const group = Math.floor(status / 100);
  return group >= 1 && group <= 5 ? `${group}xx` as MetricStatusClass : "unknown";
}

export function metricTerminalStatus(status: RequestMetricObservation["terminalStatus"] | unknown): MetricTerminalStatus {
  return status === "completed" || status === "incomplete" || status === "failed" ? status : "none";
}

function requestKey(
  surface: MetricSurface,
  statusClass: MetricStatusClass,
  terminalStatus: MetricTerminalStatus,
): string {
  return `${surface}\u0000${statusClass}\u0000${terminalStatus}`;
}

function tokenKey(surface: MetricSurface, type: MetricTokenType): string {
  return `${surface}\u0000${type}`;
}

function emptyHistogram(bounds: readonly number[]): HistogramState {
  return { counts: bounds.map(() => 0), count: 0, sum: 0 };
}

function observeHistogram(state: HistogramState, bounds: readonly number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  state.count = addCounter(state.count, 1);
  state.sum = addSum(state.sum, value);
  for (let index = 0; index < bounds.length; index += 1) {
    if (value <= bounds[index]) state.counts[index] = addCounter(state.counts[index], 1);
  }
}

function surfaceRank(surface: MetricSurface): number {
  return SURFACE_ORDER.indexOf(surface);
}

function statusRank(status: MetricStatusClass): number {
  return STATUS_ORDER.indexOf(status);
}

function terminalRank(status: MetricTerminalStatus): number {
  return TERMINAL_ORDER.indexOf(status);
}

function tokenRank(type: MetricTokenType): number {
  return TOKEN_ORDER.indexOf(type);
}

function defaultProcessMetrics(): ProcessMetricsSnapshot {
  const usage = process.memoryUsage();
  return {
    uptimeSeconds: nonNegativeFinite(process.uptime()),
    residentMemoryBytes: counterValue(usage.rss),
    heapUsedBytes: counterValue(usage.heapUsed),
    heapTotalBytes: counterValue(usage.heapTotal),
    externalMemoryBytes: counterValue(usage.external),
    arrayBuffersBytes: counterValue(usage.arrayBuffers),
    activeTurns: counterValue(getActiveTurnCount()),
    draining: isDraining(),
  };
}

function normalizeProcessMetrics(value: ProcessMetricsSnapshot): ProcessMetricsSnapshot {
  return {
    uptimeSeconds: nonNegativeFinite(value.uptimeSeconds),
    residentMemoryBytes: counterValue(value.residentMemoryBytes),
    heapUsedBytes: counterValue(value.heapUsedBytes),
    heapTotalBytes: counterValue(value.heapTotalBytes),
    externalMemoryBytes: counterValue(value.externalMemoryBytes),
    arrayBuffersBytes: counterValue(value.arrayBuffersBytes),
    activeTurns: counterValue(value.activeTurns),
    draining: value.draining === true,
  };
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labels(values: Record<string, string>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) return "";
  return `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;
}

function metricNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

export class RuntimeMetrics {
  private readonly requests = new Map<string, RequestCounterState>();
  private readonly durations = new Map<MetricSurface, HistogramState>();
  private readonly firstOutput = new Map<MetricSurface, HistogramState>();
  private readonly tokenCounts = new Map<string, TokenCounterState>();

  constructor(
    private readonly processCollector: () => ProcessMetricsSnapshot = defaultProcessMetrics,
    private readonly now: () => number = Date.now,
  ) {}

  reset(): void {
    this.requests.clear();
    this.durations.clear();
    this.firstOutput.clear();
    this.tokenCounts.clear();
  }

  recordRequest(entry: RequestMetricObservation): void {
    const surface = metricSurface(entry.surface);
    const statusClass = metricStatusClass(entry.status);
    const terminalStatus = metricTerminalStatus(entry.terminalStatus);
    const key = requestKey(surface, statusClass, terminalStatus);
    const request = this.requests.get(key) ?? {
      surface,
      statusClass,
      terminalStatus,
      count: 0,
    };
    request.count = addCounter(request.count, 1);
    this.requests.set(key, request);

    const duration = this.durations.get(surface) ?? emptyHistogram(REQUEST_DURATION_BUCKETS_MS);
    observeHistogram(duration, REQUEST_DURATION_BUCKETS_MS, entry.durationMs);
    this.durations.set(surface, duration);

    // Only materialize the per-surface histogram for valid samples: an invalid
    // observation (NaN/Infinity/negative) is discarded by observeHistogram anyway,
    // and creating an empty series for it would surface a misleading zero histogram.
    if (entry.firstOutputMs !== undefined && Number.isFinite(entry.firstOutputMs) && entry.firstOutputMs >= 0) {
      const firstOutput = this.firstOutput.get(surface) ?? emptyHistogram(FIRST_OUTPUT_BUCKETS_MS);
      observeHistogram(firstOutput, FIRST_OUTPUT_BUCKETS_MS, entry.firstOutputMs);
      this.firstOutput.set(surface, firstOutput);
    }

    const usage = entry.usage;
    if (!usage) return;
    this.addTokens(surface, "input", usage.inputTokens);
    this.addTokens(surface, "output", usage.outputTokens);
    this.addTokens(surface, "cache_read", usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0);
    this.addTokens(surface, "cache_write", usage.cacheCreationInputTokens ?? 0);
    this.addTokens(surface, "reasoning_output", usage.reasoningOutputTokens ?? 0);
  }

  snapshot(): MetricsSnapshot {
    const processSnapshot = normalizeProcessMetrics(this.processCollector());
    return {
      version: 1,
      generatedAt: counterValue(this.now()),
      process: processSnapshot,
      requests: [...this.requests.values()]
        .map(value => ({ ...value }))
        .sort((left, right) => surfaceRank(left.surface) - surfaceRank(right.surface)
          || statusRank(left.statusClass) - statusRank(right.statusClass)
          || terminalRank(left.terminalStatus) - terminalRank(right.terminalStatus)),
      requestDurationMs: this.histogramSnapshots(this.durations, REQUEST_DURATION_BUCKETS_MS),
      firstOutputMs: this.histogramSnapshots(this.firstOutput, FIRST_OUTPUT_BUCKETS_MS),
      tokens: [...this.tokenCounts.values()]
        .map(value => ({ ...value }))
        .sort((left, right) => surfaceRank(left.surface) - surfaceRank(right.surface)
          || tokenRank(left.type) - tokenRank(right.type)),
    };
  }

  prometheus(): string {
    const snapshot = this.snapshot();
    const lines: string[] = [];
    const help = (name: string, type: "counter" | "gauge" | "histogram", description: string) => {
      lines.push(`# HELP ${name} ${description}`);
      lines.push(`# TYPE ${name} ${type}`);
    };

    help("opencodex_requests_total", "counter", "Completed proxy requests by bounded surface and status classification.");
    for (const request of snapshot.requests) {
      lines.push(`opencodex_requests_total${labels({
        surface: request.surface,
        status_class: request.statusClass,
        terminal_status: request.terminalStatus,
      })} ${metricNumber(request.count)}`);
    }

    this.appendHistogram(
      lines,
      "opencodex_request_duration_ms",
      "Request duration in milliseconds by bounded surface.",
      snapshot.requestDurationMs,
    );
    this.appendHistogram(
      lines,
      "opencodex_time_to_first_output_ms",
      "Time to first model output in milliseconds by bounded surface.",
      snapshot.firstOutputMs,
    );

    help("opencodex_tokens_total", "counter", "Observed token counts by bounded surface and token category.");
    for (const token of snapshot.tokens) {
      lines.push(`opencodex_tokens_total${labels({ surface: token.surface, type: token.type })} ${metricNumber(token.count)}`);
    }

    help("opencodex_active_turns", "gauge", "Current number of active proxy turns.");
    lines.push(`opencodex_active_turns ${metricNumber(snapshot.process.activeTurns)}`);
    help("opencodex_draining", "gauge", "Whether the proxy is draining active turns (1 or 0).");
    lines.push(`opencodex_draining ${snapshot.process.draining ? "1" : "0"}`);
    help("opencodex_process_uptime_seconds", "gauge", "Proxy process uptime in seconds.");
    lines.push(`opencodex_process_uptime_seconds ${metricNumber(snapshot.process.uptimeSeconds)}`);
    help("opencodex_process_resident_memory_bytes", "gauge", "Resident process memory in bytes.");
    lines.push(`opencodex_process_resident_memory_bytes ${metricNumber(snapshot.process.residentMemoryBytes)}`);
    help("opencodex_process_heap_used_bytes", "gauge", "JavaScript heap used in bytes.");
    lines.push(`opencodex_process_heap_used_bytes ${metricNumber(snapshot.process.heapUsedBytes)}`);
    help("opencodex_process_heap_total_bytes", "gauge", "JavaScript heap total in bytes.");
    lines.push(`opencodex_process_heap_total_bytes ${metricNumber(snapshot.process.heapTotalBytes)}`);
    help("opencodex_process_external_memory_bytes", "gauge", "External/native memory tracked by the runtime in bytes.");
    lines.push(`opencodex_process_external_memory_bytes ${metricNumber(snapshot.process.externalMemoryBytes)}`);
    help("opencodex_process_array_buffers_bytes", "gauge", "ArrayBuffer memory tracked by the runtime in bytes.");
    lines.push(`opencodex_process_array_buffers_bytes ${metricNumber(snapshot.process.arrayBuffersBytes)}`);

    return `${lines.join("\n")}\n`;
  }

  private addTokens(surface: MetricSurface, type: MetricTokenType, amount: number): void {
    const key = tokenKey(surface, type);
    const token = this.tokenCounts.get(key) ?? { surface, type, count: 0 };
    token.count = addCounter(token.count, amount);
    this.tokenCounts.set(key, token);
  }

  private histogramSnapshots(
    source: ReadonlyMap<MetricSurface, HistogramState>,
    bounds: readonly number[],
  ): HistogramSnapshot[] {
    return [...source.entries()]
      .map(([surface, state]) => ({
        surface,
        buckets: bounds.map((le, index) => ({ le, count: state.counts[index] })),
        count: state.count,
        sum: state.sum,
      }))
      .sort((left, right) => surfaceRank(left.surface) - surfaceRank(right.surface));
  }

  private appendHistogram(
    lines: string[],
    name: string,
    description: string,
    histograms: readonly HistogramSnapshot[],
  ): void {
    lines.push(`# HELP ${name} ${description}`);
    lines.push(`# TYPE ${name} histogram`);
    for (const histogram of histograms) {
      for (const bucket of histogram.buckets) {
        lines.push(`${name}_bucket${labels({ surface: histogram.surface, le: String(bucket.le) })} ${metricNumber(bucket.count)}`);
      }
      lines.push(`${name}_bucket${labels({ surface: histogram.surface, le: "+Inf" })} ${metricNumber(histogram.count)}`);
      lines.push(`${name}_sum${labels({ surface: histogram.surface })} ${metricNumber(histogram.sum)}`);
      lines.push(`${name}_count${labels({ surface: histogram.surface })} ${metricNumber(histogram.count)}`);
    }
  }
}

export const runtimeMetrics = new RuntimeMetrics();
