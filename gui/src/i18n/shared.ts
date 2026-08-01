import { createContext, useContext } from "react";
import { en, type TKey } from "./en";
import { nl } from "./nl";

export type Locale = "en" | "nl";
export type { TKey };

export const DICTS: Record<Locale, Record<TKey, string>> = { en, nl };

export const LOCALES: { code: Locale; name: string; htmlLang: string }[] = [
  { code: "en", name: "English", htmlLang: "en" },
  { code: "nl", name: "Nederlands", htmlLang: "nl" },
];

const LANG_KEY = "ocx-lang";

export function detectInitial(): Locale {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === "en" || stored === "nl") return stored;
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
