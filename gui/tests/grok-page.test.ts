import { expect, test } from "bun:test";
import { localeDicts } from "./helpers/locales";

async function read(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

// The page may write its own SELECTION and ask the proxy to re-run the guarded sync,
// but it must never gain a path that writes ~/.grok/config.toml directly. injectGrokConfig
// owns that file (backup, byte-for-byte preservation, non-loopback refusal).
test("the Grok page only writes selection state and triggers the guarded sync", async () => {
  const page = await read("../src/pages/Grok.tsx");
  expect(page).toContain("/api/grok/selection");
  expect(page).toContain("/api/grok/apply");
  expect(page).not.toContain("writeFile");
  expect(page).not.toContain("atomicWriteFile");
});

// UX-STATE-01: absent is a normal state, not a failure — it must name the next action rather
// than rendering an empty panel, and the error state must offer a way out.
test("the Grok page covers loading, absent and error states", async () => {
  const page = await read("../src/pages/Grok.tsx");
  expect(page).toContain("grok.loading");
  expect(page).toContain("grok.notConfiguredTitle");
  expect(page).toContain("grok.notConfiguredHint");
  expect(page).toContain("common.retry");
});

test("the Grok page is routable and present in the nav", async () => {
  const routing = await read("../src/app-routing.ts");
  const app = await read("../src/App.tsx");
  // New IA: Grok lives as a Leveranciers sub-view; the bare #grok hash is a legacy redirect.
  expect(routing).toContain('grok: "leveranciers/grok"');
  expect(app).toContain('route.sub === "grok" && <Grok apiBase={API_BASE} />');
  expect(app).toContain('{ sub: "grok", tkey: "nav.grok" }');
});

test("every locale carries the Grok keys", () => {
  const keys = ["nav.grok", "grok.title", "grok.subtitle", "grok.loading", "grok.loadFail",
    "grok.notConfiguredTitle", "grok.notConfiguredHint", "grok.endpoint",
    "grok.colModel", "grok.colAlias", "grok.colContext",
    "grok.groupNative", "grok.groupRouted", "grok.enabledCount",
    "grok.saved", "grok.savedApplied", "grok.saveFailed", "grok.applyFailed",
    "grok.applySkipped", "grok.saveApply", "grok.saving", "grok.applying",
    "grok.unsaved", "grok.upToDate", "grok.toggleModel"];
  const missing: string[] = [];
  for (const [locale, dict] of localeDicts()) {
    for (const key of keys) {
      if (!(dict[key as keyof typeof dict] ?? "").trim()) missing.push(`${locale}:${key}`);
    }
  }
  expect(missing).toEqual([]);
});
