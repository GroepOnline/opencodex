import { expect, test } from "bun:test";
import { localeDicts } from "./helpers/locales";

async function read(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

// D3: the usage page exposes the grok surface next to all/codex/claude, with its icon.
test("the Usage filter includes grok with its icon", async () => {
  const page = await read("../src/pages/Usage.tsx");
  expect(page).toContain('"grok"');
  expect(page).toContain('(["all", "codex", "claude", "grok"]');
  expect(page).toContain("/provider-icons/grok.svg");
});

test("every locale carries the grok surface label", () => {
  const missing: string[] = [];
  for (const [locale, dict] of localeDicts()) {
    if (!(dict["logs.filter.surface.grok"] ?? "").trim()) missing.push(locale);
  }
  expect(missing).toEqual([]);
});
