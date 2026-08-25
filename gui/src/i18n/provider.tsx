import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { cachedDict, I18nContext, LOCALES, loadDict, detectInitial, interpolate, type TFn, type TKey, type Vars } from "./shared";
import { useI18n } from "./shared";

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(detectInitial);
  // Sync when the dict is already cached (warm SPA navigation, seeded SSR/tests).
  const [dict, setDict] = useState<Record<TKey, string> | null>(() => cachedDict(locale) ?? null);

  useEffect(() => {
    let active = true;
    void loadDict(locale).then(loaded => {
      if (active) setDict(loaded);
    });
    return () => { active = false; };
  }, [locale]);

  useEffect(() => {
    const meta = LOCALES.find(l => l.code === locale) ?? LOCALES[0];
    document.documentElement.lang = meta.htmlLang;
    try { localStorage.setItem("ocx-lang", locale); } catch { /* ignore */ }
  }, [locale]);

  // nl spreads en at module level, so the loaded dict already carries English fallbacks.
  const t: TFn = useCallback(
    (key, vars) => interpolate((dict && dict[key]) ?? key, vars),
    [dict],
  );
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, t]);

  // First paint waits for the active dictionary: t() must be sync once children mount.
  if (!dict) return null;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function Trans({ k, cmd, vars }: { k: TKey; cmd: string; vars?: Vars }) {
  const { t } = useI18n();
  const [pre, post = ""] = t(k, vars).split("{cmd}");
  return <>{pre}<code className="chip">{cmd}</code>{post}</>;
}
