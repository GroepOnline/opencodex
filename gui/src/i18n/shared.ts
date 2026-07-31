import { createContext, useContext } from "react";
import { en, type TKey } from "./en";
<<<<<<< HEAD
import { de } from "./de";
import { ko } from "./ko";
import { zh } from "./zh";
import { ru } from "./ru";
import { ja } from "./ja";
||||||| parent of dfc8543b (fix(gui): complete English i18n and keep only en/nl locales)
import { nl } from "./nl";
import { de } from "./de";
import { ko } from "./ko";
import { zh } from "./zh";
import { ru } from "./ru";
import { ja } from "./ja";
=======
import { nl } from "./nl";
>>>>>>> dfc8543b (fix(gui): complete English i18n and keep only en/nl locales)

<<<<<<< HEAD
export type Locale = "en" | "de" | "ko" | "zh" | "ru" | "ja";
||||||| parent of dfc8543b (fix(gui): complete English i18n and keep only en/nl locales)
export type Locale = "en" | "nl" | "de" | "ko" | "zh" | "ru" | "ja";
=======
export type Locale = "en" | "nl";
>>>>>>> dfc8543b (fix(gui): complete English i18n and keep only en/nl locales)
export type { TKey };

<<<<<<< HEAD
export const DICTS: Record<Locale, Record<TKey, string>> = { en, de, ko, zh, ru, ja };
||||||| parent of dfc8543b (fix(gui): complete English i18n and keep only en/nl locales)
export const DICTS: Record<Locale, Record<TKey, string>> = { en, nl, de, ko, zh, ru, ja };
=======
export const DICTS: Record<Locale, Record<TKey, string>> = { en, nl };
>>>>>>> dfc8543b (fix(gui): complete English i18n and keep only en/nl locales)

export const LOCALES: { code: Locale; name: string; htmlLang: string }[] = [
  { code: "en", name: "English", htmlLang: "en" },
];

const LANG_KEY = "ocx-lang";

export function detectInitial(): Locale {
  try {
    const stored = localStorage.getItem(LANG_KEY);
<<<<<<< HEAD
    if (stored === "en" || stored === "de" || stored === "ko" || stored === "zh" || stored === "ru" || stored === "ja") return stored;
||||||| parent of dfc8543b (fix(gui): complete English i18n and keep only en/nl locales)
    if (stored === "en" || stored === "nl" || stored === "de" || stored === "ko" || stored === "zh" || stored === "ru" || stored === "ja") return stored;
=======
    if (stored === "en" || stored === "nl") return stored;
>>>>>>> dfc8543b (fix(gui): complete English i18n and keep only en/nl locales)
  } catch { /* ignore */ }
<<<<<<< HEAD
  const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "en";
  if (nav.startsWith("de")) return "de";
  if (nav.startsWith("ko")) return "ko";
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("ru")) return "ru";
  if (nav.startsWith("ja")) return "ja";
  return "en";
||||||| parent of dfc8543b (fix(gui): complete English i18n and keep only en/nl locales)
  const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "nl";
  if (nav.startsWith("en")) return "en";
  if (nav.startsWith("de")) return "de";
  if (nav.startsWith("ko")) return "ko";
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("ru")) return "ru";
  if (nav.startsWith("ja")) return "ja";
  // ChefGroep host build: Joep-facing copy is Dutch by default (DESIGN.md voice-kit).
  // The language switcher in the sidebar still offers English and the rest.
  return "nl";
=======
  const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "nl";
  if (nav.startsWith("en")) return "en";
  // ChefGroep host build: Joep-facing copy is Dutch by default (DESIGN.md voice-kit).
  // The language switcher in the sidebar still offers English.
  return "nl";
>>>>>>> dfc8543b (fix(gui): complete English i18n and keep only en/nl locales)
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
