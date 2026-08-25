import { DICTS, type Locale, type TKey } from "../../src/i18n/dicts";
import { loadDict } from "../../src/i18n/shared";

/**
 * Seed the provider's module-level dict cache so LanguageProvider renders synchronously
 * in SSR tests. Call via top-level `await seedDicts();` at the top of a test file.
 */
export async function seedDicts(): Promise<void> {
  await Promise.all([loadDict("en"), loadDict("nl")]);
}

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
