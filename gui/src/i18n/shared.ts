import { createContext, useContext } from "react";
import type { TKey } from "./en";

export type Locale = "en" | "nl";
export type { TKey };

/**
 * Module-level cache so a warm provider renders synchronously (SSR and tests included).
 * Tests seed it via tests/helpers/locales seedDicts(); the browser pays one small chunk
 * fetch on cold load.
 */
const DICT_CACHE = new Map<Locale, Record<TKey, string>>();

export function cachedDict(locale: Locale): Record<TKey, string> | undefined {
  return DICT_CACHE.get(locale);
}

export function loadDict(locale: Locale): Promise<Record<TKey, string>> {
  const hit = DICT_CACHE.get(locale);
  if (hit) return Promise.resolve(hit);
  return LOADERS[locale]().then(dict => {
    DICT_CACHE.set(locale, dict);
    return dict;
  });
}

const LOADERS: Record<Locale, () => Promise<Record<TKey, string>>> = {
  en: () => import("./en").then(m => m.en),
  // nl composes over en here, so neither dictionary sits in the eager graph while
  // English fallbacks still survive for Dutch strings.
  nl: () =>
    Promise.all([import("./en"), import("./nl")]).then(
      ([{ en }, { nlOverrides }]) => ({ ...en, ...nlOverrides }),
    ),
};

export const LOCALES: { code: Locale; name: string; htmlLang: string }[] = [
  { code: "nl", name: "Nederlands", htmlLang: "nl" },
  { code: "en", name: "English", htmlLang: "en" },
];

const LANG_KEY = "ocx-lang";

/**
 * Locales this build no longer ships (ja, ko, ru, zh removed). A saved preference for one of them was an explicit
 * "not Dutch" choice, so it migrates to English instead of falling through to the Dutch
 * default below. The migrated value is written back so the mapping runs once per browser.
 */
const RETIRED_LOCALES: Record<string, Locale> = {
  de: "en",
  ja: "en",
  ko: "en",
  ru: "en",
  zh: "en",
};

export function detectInitial(): Locale {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === "en" || stored === "nl") return stored;
    const migrated = stored ? RETIRED_LOCALES[stored] : undefined;
    if (migrated) {
      try { localStorage.setItem(LANG_KEY, migrated); } catch { /* ignore */ }
      return migrated;
    }
  } catch { /* ignore */ }
  const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "nl";
  if (nav.startsWith("en")) return "en";
  // ChefGroep host build: Joep-facing copy is Dutch by default (DESIGN.md voice-kit).
  // The language switcher in the sidebar still offers English.
  return "nl";
}

export type Vars = Record<string, string | number>;
export type TFn = (key: TKey, vars?: Vars) => string;

export interface I18nContextValue { locale: Locale; setLocale: (l: Locale) => void; t: TFn }

export const I18nContext = createContext<I18nContextValue | null>(null);

export function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  let out = s;
  for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(String(vars[k]));
  return out;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within LanguageProvider");
  return ctx;
}

export function useT(): TFn {
  return useI18n().t;
}
