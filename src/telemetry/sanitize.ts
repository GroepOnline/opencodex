/**
 * The only property keys operational telemetry may emit. A caller cannot add
 * prompt text, headers, tokens, or account identifiers without extending this set.
 */
const ALLOWED_PROPERTY_KEYS = new Set([
  "provider",
  "model",
  "adapter",
  "status",
  "outcome",
  "durationMs",
  "firstOutputMs",
  "inputTokens",
  "outputTokens",
  "cachedTokens",
  "reasoningTokens",
  "errorCode",
  "accountMode",
  "cooldownMs",
  "type",
  "threshold",
  "actual",
  "$ai_trace_id",
  "$ai_session_id",
  "$ai_generation_id",
  "$ai_model",
  "$ai_provider",
  "$ai_latency",
  "$ai_time_to_first_token",
  "$ai_input_tokens",
  "$ai_output_tokens",
  "$ai_total_cost_usd",
  "$ai_http_status",
  "$ai_is_error",
  "$ai_error",
  "$ai_stream",
  "$ai_product",
  "surface",
  "usageStatus",
  "usageEstimated",
]);

/** Keep only allowlisted metric keys with primitive values, capping string length. */
export function sanitizeTelemetryProperties(
  props: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!props || typeof props !== "object") return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!ALLOWED_PROPERTY_KEYS.has(key)) continue;
    if (typeof value === "string") {
      clean[key] = value.length > 200 ? value.slice(0, 200) : value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      clean[key] = value;
    } else if (typeof value === "boolean") {
      clean[key] = value;
    }
  }
  return clean;
}
