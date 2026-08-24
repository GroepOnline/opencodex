import { expect, test } from "bun:test";
import { localeDicts, SHIPPED_LOCALES } from "./helpers/locales";
import { en } from "../src/i18n/en";
import { DICTS } from "../src/i18n/dicts";

// `nl.ts` is typed `Record<TKey, string>`, so a MISSING key already fails `tsc`. These
// cases cover what the type cannot see: a key that exists but renders nothing, which
// would ship a blank tab label or an empty lane heading. The Claude Desktop keys arrived
// through a hand-resolved merge conflict, so they get an explicit guard.
//
// The gates read the resolved dictionaries rather than locale module text: overlay locales
// spread `en` and only override a subset, so source-text scanning would report every
// inherited key as missing.
test("every locale defines a non-empty value for each Claude Desktop key", () => {
  const desktopKeys = Object.keys(en).filter(k => k.startsWith("claudeDesktop.") || k.startsWith("claude.tab"));
  expect(desktopKeys.length).toBeGreaterThan(50);

  const blank: string[] = [];
  for (const [locale, dict] of localeDicts()) {
    for (const key of desktopKeys) {
      if (!(dict[key as keyof typeof dict] ?? "").trim()) blank.push(`${locale}:${key}`);
    }
  }
  expect(blank).toEqual([]);
});

test("locale key sets stay identical to the English source", () => {
  const enKeys = Object.keys(en).sort();
  for (const locale of SHIPPED_LOCALES.filter(l => l !== "en")) {
    const other = Object.keys(DICTS[locale]).sort();
    expect(`${locale}:${other.length}`).toBe(`${locale}:${enKeys.length}`);
    expect(other).toEqual(enKeys);
  }
});
