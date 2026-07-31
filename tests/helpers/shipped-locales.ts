import { en, type TKey } from "../../gui/src/i18n/en";
import { nl } from "../../gui/src/i18n/nl";

/**
 * Resolved dictionaries for every locale the GUI ships, mirroring `DICTS` in
 * `gui/src/i18n/shared.ts`.
 *
 * Copy gates must read these rather than locale file text: `nl` is an override
 * layer that spreads `en`, so a key it inherits is present at runtime while
 * absent from `nl.ts`. Keep this list in step with `shared.ts` when a locale is
 * added or dropped.
 */
export const SHIPPED_LOCALES: Record<string, Record<TKey, string>> = { en, nl };

/** Asserts every shipped locale resolves `keys` to non-empty copy. */
export function localizedCopy(keys: readonly TKey[]): { locale: string; key: TKey; value: string }[] {
  return Object.entries(SHIPPED_LOCALES).flatMap(([locale, dict]) =>
    keys.map(key => ({ locale, key, value: dict[key] })),
  );
}
