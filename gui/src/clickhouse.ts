/**
 * Dashboard writes to ClickHouse only for a passwordless loopback HTTP endpoint.
 * A password would be baked into the bundle, so authenticated ClickHouse stays
 * on the proxy via OCX_CLICKHOUSE_PASSWORD_FILE.
 *
 * https://clickhouse.com/docs/interfaces/http
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const INSERT = "INSERT INTO opencodex.ocx_events FORMAT JSONEachRow";

export function clickhouseLoopbackInsertUrl(
  raw: string | undefined,
): string | undefined {
  if (!raw?.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:") return undefined;
  if (!LOOPBACK.has(parsed.hostname)) return undefined;
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    return undefined;
  const url = new URL(parsed.origin);
  url.searchParams.set("query", INSERT);
  return url.toString();
}

export function clickhouseDashboardRow(event: "dashboard_ready") {
  return {
    ts: new Date().toISOString().replace("T", " ").replace("Z", ""),
    event,
    provider: "",
    model: "",
    status: 0,
    duration_ms: 0,
    outcome: "",
    error_code: "",
    surface: "dashboard",
  };
}

/** No-ops unless VITE_CLICKHOUSE_URL is an http loopback URL without credentials. */
export function initClickhouse(): void {
  if (typeof window === "undefined") return;
  const url = clickhouseLoopbackInsertUrl(import.meta.env.VITE_CLICKHOUSE_URL);
  if (!url) return;
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: JSON.stringify(clickhouseDashboardRow("dashboard_ready")),
    credentials: "omit",
    referrerPolicy: "no-referrer",
  }).catch(() => {});
}
