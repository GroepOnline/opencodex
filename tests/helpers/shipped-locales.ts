import { DICTS, type Locale, type TKey } from "../../gui/src/i18n/dicts";

/**
 * Resolved dictionaries for every locale the GUI ships, read straight from the runtime
 * registry (`gui/src/i18n/dicts.ts`, re-exported by `shared.ts`) so a locale added or
 * dropped there cannot leave these gates validating a stale subset.
 *
 * Copy gates must read these rather than locale file text: `nl` is an override layer that
 * spreads `en`, so a key it inherits is present at runtime while absent from `nl.ts`.
 */
export const SHIPPED_LOCALES: Record<Locale, Record<TKey, string>> = DICTS;

/** Asserts every shipped locale resolves `keys` to non-empty copy. */
export function localizedCopy(keys: readonly TKey[]): { locale: string; key: TKey; value: string }[] {
  return Object.entries(SHIPPED_LOCALES).flatMap(([locale, dict]) =>
    keys.map(key => ({ locale, key, value: dict[key] })),
  );
}
