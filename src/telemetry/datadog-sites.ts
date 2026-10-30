/**
 * Official Datadog site parameters and intake origins.
 * Logs: https://docs.datadoghq.com/api/latest/logs/
 * Browser intake: https://docs.datadoghq.com/real_user_monitoring/guide/proxy-rum-data/
 * Site list: https://docs.datadoghq.com/getting_started/site/
 */
const LOG_INTAKE: Record<string, string> = {
  "datadoghq.com": "https://http-intake.logs.datadoghq.com/api/v2/logs",
  "us3.datadoghq.com": "https://http-intake.logs.us3.datadoghq.com/api/v2/logs",
  "us5.datadoghq.com": "https://http-intake.logs.us5.datadoghq.com/api/v2/logs",
  "datadoghq.eu": "https://http-intake.logs.datadoghq.eu/api/v2/logs",
  "ap1.datadoghq.com": "https://http-intake.logs.ap1.datadoghq.com/api/v2/logs",
  "ap2.datadoghq.com": "https://http-intake.logs.ap2.datadoghq.com/api/v2/logs",
  "uk1.datadoghq.com": "https://http-intake.logs.uk1.datadoghq.com/api/v2/logs",
  "ddog-gov.com": "https://http-intake.logs.ddog-gov.com/api/v2/logs",
  "us2.ddog-gov.com": "https://http-intake.logs.us2.ddog-gov.com/api/v2/logs",
};

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

export const DEFAULT_DATADOG_SITE = "datadoghq.eu";

/** Accept `datadoghq.eu` and the app host `app.datadoghq.eu`. Unknown sites fail closed. */
export function normalizeDatadogSite(site: string | undefined): string {
  const trimmed =
    site?.trim().toLowerCase().replace(/\/+$/, "") || DEFAULT_DATADOG_SITE;
  return trimmed.startsWith("app.") ? trimmed.slice(4) : trimmed;
}

export function datadogLogsIntakeUrl(
  site: string | undefined,
): string | undefined {
  return LOG_INTAKE[normalizeDatadogSite(site)];
}

export function datadogBrowserIntakeOrigin(
  site: string | undefined,
): string | undefined {
  return BROWSER_INTAKE_ORIGIN[normalizeDatadogSite(site)];
}
