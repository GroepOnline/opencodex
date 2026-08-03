import { DICTS, type Locale, type TKey } from "../../src/i18n/shared";

/**
 * Locale gates must follow the registry, never a hand-maintained list. A hardcoded
 * array silently turns into a no-op (or an ENOENT) the moment the shipped locale set
 * changes, which is exactly when these gates need to fire.
 */
export const SHIPPED_LOCALES = Object.keys(DICTS) as Locale[];

/** Resolved dictionary per locale. Overlay locales (nl spreads en) resolve to full maps. */
export function localeDicts(): [Locale, Record<TKey, string>][] {
  return SHIPPED_LOCALES.map(locale => [locale, DICTS[locale]]);
}

/** Raw locale module source, for gates that assert a key is absent from the source. */
export async function localeSource(locale: Locale): Promise<string> {
  return await Bun.file(new URL(`../../src/i18n/${locale}.ts`, import.meta.url)).text();
}
