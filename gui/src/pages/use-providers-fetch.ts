import { useCallback } from "react";
import type { TFn } from "../i18n/shared";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import { writeSessionListCache } from "../session-list-cache";
import type { AvailabilityProviderView, OAuthStatus, ProviderQuotaReport, ProvidersConfig } from "./providers-shared";

/** Live routing is optional: a down /api/availability must not block /api/config. */
export async function readAvailabilityProviders(
  input: Promise<Response | null>,
): Promise<AvailabilityProviderView[]> {
  try {
    const availRes = await input;
    if (!availRes?.ok) return [];
    const avail = await readJsonIfOk<{ providers?: AvailabilityProviderView[] }>(availRes);
    return Array.isArray(avail?.providers) ? avail.providers : [];
  } catch {
    return [];
  }
}

export function useProvidersFetch({
  apiBase,
  t,
  setConfig,
  setOauthProviders,
  setOauthStatus,
  setQuotaReports,
  setAvailability,
  notify,
  configCacheKey,
}: {
  apiBase: string;
  t: TFn;
  setConfig: React.Dispatch<React.SetStateAction<ProvidersConfig | null>>;
  setOauthProviders: React.Dispatch<React.SetStateAction<string[]>>;
  setOauthStatus: React.Dispatch<React.SetStateAction<Record<string, OAuthStatus>>>;
  setQuotaReports: React.Dispatch<React.SetStateAction<Record<string, ProviderQuotaReport>>>;
  setAvailability?: React.Dispatch<React.SetStateAction<AvailabilityProviderView[]>>;
  notify: (msg: string, ok: boolean) => void;
  /** Session seed key for instant Providers shell paint (no secrets — hasApiKey flags only). */
  configCacheKey?: string;
}) {
  const fetchConfig = useCallback(async () => {
    const availPromise = setAvailability
      ? fetch(`${apiBase}/api/availability`).catch(() => null)
      : null;
    try {
      const res = await fetch(`${apiBase}/api/config`);
      const data = await readJsonOrThrow<ProvidersConfig>(res);
      setConfig(data ?? null);
      if (configCacheKey && data) writeSessionListCache(configCacheKey, data);
    } catch {
      notify(t("prov.loadConfigFail"), false);
      return;
    }
    if (setAvailability && availPromise) {
      setAvailability(await readAvailabilityProviders(availPromise));
    }
  }, [apiBase, configCacheKey, notify, setAvailability, setConfig, t]);

  const fetchOauth = useCallback(async () => {
    try {
      // Codex openai status is owned by useCodexAccountPool — do not duplicate /accounts.
      const provRes = await fetch(`${apiBase}/api/oauth/providers`);
      const provData = await readJsonOrThrow<{ providers?: string[] }>(provRes);
      const provs: string[] = provData?.providers ?? [];
      setOauthProviders(provs);
      const oauthEntries = await Promise.all(provs.map(async p => {
        const sRes = await fetch(`${apiBase}/api/oauth/status?provider=${encodeURIComponent(p)}`).catch(() => null);
        const s = sRes ? (await readJsonIfOk<OAuthStatus>(sRes) ?? { loggedIn: false }) : { loggedIn: false };
        return [p, s] as const;
      }));
      setOauthStatus(Object.fromEntries(oauthEntries));
    } catch { /* ignore */ }
  }, [apiBase, setOauthProviders, setOauthStatus]);

  const fetchProviderQuotas = useCallback(async (refresh = false) => {
    try {
      const res = await fetch(`${apiBase}/api/provider-quotas${refresh ? "?refresh=1" : ""}`);
      const data = await readJsonIfOk<{ reports?: ProviderQuotaReport[] }>(res);
      if (!data) return;
      setQuotaReports(prev => {
        const next = { ...prev };
        for (const report of data.reports ?? []) {
          if (report?.provider) next[report.provider] = report;
        }
        return next;
      });
    } catch { /* keep last-good */ }
  }, [apiBase, setQuotaReports]);

  return { fetchConfig, fetchOauth, fetchProviderQuotas };
}
