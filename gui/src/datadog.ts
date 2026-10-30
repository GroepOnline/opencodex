/**
 * Opt-in Datadog browser logs. Uses a public client token, never an API key.
 * Payloads are a fixed message with no URL, stack, or account data.
 *
 * https://docs.datadoghq.com/logs/log_collection/javascript/
 * Intake origins: https://docs.datadoghq.com/real_user_monitoring/guide/proxy-rum-data/
 */

const BROWSER_INTAKE_ORIGIN: Record<string, string> = {
  "datadoghq.com": "https://browser-intake-datadoghq.com",
  "us3.datadoghq.com": "https://browser-intake-us3-datadoghq.com",
  "us5.datadoghq.com": "https://browser-intake-us5-datadoghq.com",
  "datadoghq.eu": "https://browser-intake-datadoghq.eu",
  "ap1.datadoghq.com": "https://browser-intake-ap1-datadoghq.com",
  "ap2.datadoghq.com": "https://browser-intake-ap2-datadoghq.com",
  "uk1.datadoghq.com": "https://browser-intake-uk1-datadoghq.com",
  "ddog-gov.com": "https://browser-intake-ddog-gov.com",
  "us2.ddog-gov.com": "https://browser-intake-us2-ddog-gov.com",
};

const DEFAULT_SITE = "datadoghq.eu";

function normalizeSite(site: string | undefined): string {
  const trimmed =
    site?.trim().toLowerCase().replace(/\/+$/, "") || DEFAULT_SITE;
  return trimmed.startsWith("app.") ? trimmed.slice(4) : trimmed;
}

/** Undefined when the site is not an official Datadog site or the token is empty. */
export function datadogBrowserLogsUrl(
  site: string | undefined,
  clientToken: string | undefined,
): string | undefined {
  const origin = BROWSER_INTAKE_ORIGIN[normalizeSite(site)];
  const token = clientToken?.trim() ?? "";
  if (!origin || !/^[A-Za-z0-9_-]{8,200}$/.test(token)) return undefined;
  const url = new URL("/api/v2/logs", origin);
  url.searchParams.set("ddsource", "browser");
  url.searchParams.set("dd-api-key", token);
  url.searchParams.set("dd-evp-origin", "browser");
  return url.toString();
}

export function datadogBrowserLog(
  message: "dashboard_ready" | "unexpected_failure",
) {
  return {
    ddsource: "browser",
    service: "opencodex-gui",
    hostname: "opencodex",
    message,
    status: message === "unexpected_failure" ? "error" : "info",
  };
}

/** No-ops unless VITE_DATADOG_CLIENT_TOKEN is set. Does not read or send an API key. */
export function initDatadog(): void {
  if (typeof window === "undefined") return;
  const url = datadogBrowserLogsUrl(
    import.meta.env.VITE_DATADOG_SITE,
    import.meta.env.VITE_DATADOG_CLIENT_TOKEN,
  );
  if (!url) return;
  const send = (message: "dashboard_ready" | "unexpected_failure") => {
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([datadogBrowserLog(message)]),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      keepalive: true,
    }).catch(() => {});
  };
  window.addEventListener("error", () => {
    send("unexpected_failure");
  });
  send("dashboard_ready");
}
