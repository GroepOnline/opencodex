import { expect, test } from "bun:test";
import { resolveAppHashChange } from "../src/app-routing";

/**
 * Account management belongs to Leveranciers (the Providers home): that workspace
 * handles OAuth account sets and API-key pools for every provider and embeds the
 * special OpenAI pool. The old hash stays a passive compatibility redirect.
 */

test("the view tabs expose one provider-independent account destination", async () => {
  const src = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

  expect(src).toContain('{ view: "leveranciers", tkey: "nav.providers" }');
  expect(src).not.toContain('"codex-auth"');
  expect(src).not.toContain('route.sub === "codex-auth"');
});

test("legacy Codex Auth links redirect to all-provider account management", () => {
  expect(resolveAppHashChange("codex-auth")).toEqual({
    route: { view: "leveranciers", sub: null },
    replaceTo: "leveranciers",
  });
  expect(resolveAppHashChange("codex-auth/accounts")).toEqual({
    route: { view: "leveranciers", sub: null },
    replaceTo: "leveranciers",
  });
});
