/**
 * Shipped locale registry, deliberately free of React imports.
 *
 * `shared.ts` re-exports these, so GUI code keeps importing from `./shared`. Keeping the
 * registry itself React-free lets the non-GUI copy gates in `tests/helpers/shipped-locales.ts`
 * read the same source of truth instead of maintaining their own locale list.
 */
import { en, type TKey } from "./en";
import { nlOverrides } from "./nl";

export type Locale = "en" | "nl";
export type { TKey };

export const DICTS: Record<Locale, Record<TKey, string>> = {
  en,
  // Runtime composes the same overlay in i18n/shared DICT_LOADERS.
  nl: { ...en, ...nlOverrides },
};
