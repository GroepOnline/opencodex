import { expect, test } from "bun:test";

const LOCALES = ["en"] as const; // full dictionaries; nl.ts spreads en and only overrides a subset

async function readDict(locale: string): Promise<Map<string, string>> {
  const src = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/gm)) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

// `en.ts` is the source of truth for `TKey`, so a MISSING key already fails `tsc`. These
// cases cover what the type cannot see: a key that exists but renders nothing, which
// would ship a blank tab label or an empty lane heading. The Claude Desktop keys arrived
// through a hand-resolved merge conflict, so they get an explicit guard.
test("every locale defines a non-empty value for each Claude Desktop key", async () => {
  const en = await readDict("en");
  const desktopKeys = [...en.keys()].filter(k => k.startsWith("claudeDesktop.") || k.startsWith("claude.tab"));
  expect(desktopKeys.length).toBeGreaterThan(50);

  const blank: string[] = [];
  for (const locale of LOCALES) {
    const dict = await readDict(locale);
    for (const key of desktopKeys) {
      if (!(dict.get(key) ?? "").trim()) blank.push(`${locale}:${key}`);
    }
  }
  expect(blank).toEqual([]);
});

// Dutch is an override layer spread over `en`, so it cannot be missing keys. What it CAN
// carry is a stale or misspelled key that silently never renders, which `Partial<Record<TKey, string>>`
// only catches for keys tsc can see as literals — this guards the source text directly.
test("Dutch overrides only reference keys that exist in the English source", async () => {
  const en = await readDict("en");
  const unknown = [...(await readDict("nl")).keys()].filter(k => !en.has(k));
  expect(unknown).toEqual([]);
});
