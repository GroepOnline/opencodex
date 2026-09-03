/**
 * Opt-in OAuth account pool controls for Anthropic, Cursor, and Google Antigravity.
 * Experimental — each provider shows its own warning; Cursor never reuses Claude copy.
 */
import { useCallback, useEffect, useState } from "react";
import { useT, type TKey } from "../../i18n/shared";
import {
  DEFAULT_ACCOUNT_POOL_STICKY_LIMIT,
  DEFAULT_ACCOUNT_POOL_STRATEGY,
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  parseAccountPoolStickyLimitDraft,
  type AccountPoolStrategy,
} from "../../account-pool-strategy";
import AccountPoolStrategyControls from "../AccountPoolStrategyControls";

export type OAuthPoolProvider = "anthropic" | "cursor" | "google-antigravity";

type PoolState = {
  enabled: boolean;
  threshold: number;
  strategy: AccountPoolStrategy;
  stickyLimit: number;
};

const TITLE_KEYS: Record<OAuthPoolProvider, TKey> = {
  anthropic: "oauthPool.title.anthropic",
  cursor: "oauthPool.title.cursor",
  "google-antigravity": "oauthPool.title.googleAntigravity",
};

const WARNING_KEYS: Record<OAuthPoolProvider, TKey> = {
  anthropic: "oauthPool.warning.anthropic",
  cursor: "oauthPool.warning.cursor",
  "google-antigravity": "oauthPool.warning.googleAntigravity",
};

const ENABLED_DESC_KEYS: Record<OAuthPoolProvider, TKey> = {
  anthropic: "oauthPool.enabledDesc.anthropic",
  cursor: "oauthPool.enabledDesc.cursor",
  "google-antigravity": "oauthPool.enabledDesc.googleAntigravity",
};

export default function OAuthAccountPoolSettings({
  provider,
  apiBase,
  accountCount,
}: {
  provider: OAuthPoolProvider;
  apiBase: string;
  accountCount: number;
}) {
  const t = useT();
  const [state, setState] = useState<PoolState | null>(null);
  const [draft, setDraft] = useState("80");
  const [stickyDraft, setStickyDraft] = useState(String(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(`${apiBase}/api/oauth/accounts/pool?provider=${encodeURIComponent(provider)}`, {
          signal: ac.signal,
        });
        if (!res.ok) throw new Error("load");
        const json = await res.json() as {
          enabled?: boolean;
          autoSwitchThreshold?: number;
          strategy?: unknown;
          stickyLimit?: unknown;
        };
        if (cancelled) return;
        const nextEnabled = json.enabled === true;
        const nextThreshold = typeof json.autoSwitchThreshold === "number" ? json.autoSwitchThreshold : 80;
        const nextStrategy = normalizeAccountPoolStrategy(json.strategy);
        const nextSticky = normalizeAccountPoolStickyLimit(json.stickyLimit);
        setState({
          enabled: nextEnabled,
          threshold: nextThreshold,
          strategy: nextStrategy,
          stickyLimit: nextSticky,
        });
        setDraft(String(nextThreshold));
        setStickyDraft(String(nextSticky));
        setLoadError(false);
      } catch {
        if (cancelled || ac.signal.aborted) return;
        setLoadError(true);
      }
    };
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => {
      cancelled = true;
      ac.abort();
      window.clearTimeout(timer);
    };
  }, [apiBase, provider, accountCount]);

  const save = useCallback(async (next: {
    enabled: boolean;
    threshold: number;
    strategy: AccountPoolStrategy;
    stickyLimit: number;
  }) => {
    const previousState = state;
    setState({
      enabled: next.enabled,
      threshold: next.threshold,
      strategy: next.strategy,
      stickyLimit: next.stickyLimit,
    });
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts/pool`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          enabled: next.enabled,
          autoSwitchThreshold: next.threshold,
          strategy: next.strategy,
          stickyLimit: next.stickyLimit,
        }),
      });
      if (!res.ok) throw new Error("save");
      const json = await res.json().catch(() => null) as {
        strategy?: unknown;
        stickyLimit?: unknown;
      } | null;
      const savedStrategy = normalizeAccountPoolStrategy(json?.strategy ?? next.strategy);
      const savedSticky = normalizeAccountPoolStickyLimit(json?.stickyLimit ?? next.stickyLimit);
      setState({
        enabled: next.enabled,
        threshold: next.threshold,
        strategy: savedStrategy,
        stickyLimit: savedSticky,
      });
      setDraft(String(next.threshold));
      setStickyDraft(String(savedSticky));
    } catch {
      setError(t("oauthPool.saveFailed"));
      if (previousState) {
        setState(previousState);
        setDraft(String(previousState.threshold));
        setStickyDraft(String(previousState.stickyLimit));
      }
    } finally {
      setSaving(false);
    }
  }, [apiBase, provider, state, t]);

  const enabled = state?.enabled === true;
  const threshold = state?.threshold ?? 80;
  const strategy = state?.strategy ?? DEFAULT_ACCOUNT_POOL_STRATEGY;
  const stickyLimit = state?.stickyLimit ?? DEFAULT_ACCOUNT_POOL_STICKY_LIMIT;
  const loading = state === null && !loadError;
  const toggleDisabled = loading || saving || loadError || (!enabled && accountCount < 2);

  return (
    <div className="card" style={{ marginTop: 12 }} aria-busy={loading || saving}>
      <div className="card-row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <strong>{t(TITLE_KEYS[provider])}</strong>
          <div className="card-sub" style={{ marginTop: 4 }}>
            {loadError
              ? t("oauthPool.loadFailed")
              : loading
                ? t("common.loading")
                : enabled
                  ? t(ENABLED_DESC_KEYS[provider], { threshold })
                  : t("oauthPool.disabledDesc")}
          </div>
        </div>
        <label className="toggle" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={toggleDisabled}
            onChange={(event) => {
              const next = event.target.checked;
              void save({
                enabled: next,
                threshold,
                strategy,
                stickyLimit,
              });
            }}
          />
          <span>{enabled ? t("oauthPool.on") : t("oauthPool.off")}</span>
        </label>
      </div>

      <div
        role="alert"
        className="card-sub"
        style={{
          marginTop: 10,
          padding: "8px 10px",
          border: "1px solid color-mix(in srgb, var(--amber) 40%, transparent)",
          borderRadius: "var(--radius-sm)",
          background: "var(--amber-soft)",
        }}
      >
        {t(WARNING_KEYS[provider])}
      </div>

      {accountCount < 2 && (
        <div className="card-sub" style={{ marginTop: 8 }}>{t("oauthPool.needTwoAccounts")}</div>
      )}

      {enabled && state && (
        <>
          <label className="field" style={{ display: "block", marginTop: 12 }}>
            <span className="field-label">{t("oauthPool.threshold")}</span>
            <input
              className="input mono"
              type="number"
              min={0}
              max={100}
              step={1}
              value={draft}
              disabled={saving}
              aria-label={t("oauthPool.thresholdAria")}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => {
                const parsed = Number(draft);
                if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
                  setDraft(String(threshold));
                  setError(t("oauthPool.thresholdInvalid"));
                  return;
                }
                if (parsed !== threshold) {
                  void save({
                    enabled: true,
                    threshold: parsed,
                    strategy,
                    stickyLimit,
                  });
                }
              }}
            />
            <div className="card-sub" style={{ marginTop: 4 }}>{t("oauthPool.thresholdHelp")}</div>
          </label>

          <AccountPoolStrategyControls
            strategy={strategy}
            stickyDraft={stickyDraft}
            disabled={saving}
            onStrategyChange={(next) => {
              if (next === strategy) return;
              void save({
                enabled: true,
                threshold,
                strategy: next,
                stickyLimit,
              });
            }}
            onStickyDraftChange={setStickyDraft}
            onStickyCommit={(nextDraft) => {
              const parsed = parseAccountPoolStickyLimitDraft(nextDraft ?? stickyDraft);
              if (parsed === null) {
                setStickyDraft(String(stickyLimit));
                setError(t("accountPool.stickyLimitInvalid"));
                return;
              }
              if (parsed === stickyLimit) {
                setStickyDraft(String(parsed));
                return;
              }
              void save({
                enabled: true,
                threshold,
                strategy,
                stickyLimit: parsed,
              });
            }}
          />
        </>
      )}

      {error && (
        <div role="alert" className="card-sub" style={{ marginTop: 8, color: "var(--red)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
