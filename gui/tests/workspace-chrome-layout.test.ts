import { expect, test } from "bun:test";

test("workspace chrome composes from PageHeader and PageSubtitle", async () => {
  const providers = await Bun.file(
    new URL("../src/pages/Providers.tsx", import.meta.url),
  ).text();
  const apiKeys = await Bun.file(
    new URL("../src/pages/ApiKeys.tsx", import.meta.url),
  ).text();
  const subagents = await Bun.file(
    new URL("../src/pages/Subagents.tsx", import.meta.url),
  ).text();
  const claudeCode = await Bun.file(
    new URL("../src/pages/ClaudeCode.tsx", import.meta.url),
  ).text();
  const models = await Bun.file(
    new URL("../src/pages/Models.tsx", import.meta.url),
  ).text();
  const debug = await Bun.file(
    new URL("../src/pages/debug-settings-panel.tsx", import.meta.url),
  ).text();

  expect(providers).toContain("<ProvidersPageHeader");
  expect(providers).toContain("<PageHeader");
  expect(providers).toContain('actionsClassName="row"');
  expect(providers).not.toContain('className="page-head"');

  expect(apiKeys).toContain("<PageHeader");
  expect(apiKeys).toContain("<PageSubtitle");
  expect(apiKeys).not.toContain('className="page-head"');

  expect(subagents).toContain("<PageHeader");
  expect(subagents).not.toContain('className="page-head"');

  expect(claudeCode).toContain("<PageHeader");
  expect(claudeCode).toContain("<PageSubtitle");
  expect(claudeCode).toContain('actionsClassName="claudecode-workspace-save"');
  expect(claudeCode).not.toContain('className="page-head"');

  expect(models).toContain("<PageHeader");
  expect(models).toContain('descriptionClassName="models-catalog-description"');
  expect(models).not.toContain('className="page-head"');

  expect(debug).toContain("export function DebugPageHeader");
  expect(debug).toContain("<PageHeader");
  expect(debug).toContain("<PageSubtitle");
  expect(debug).toMatch(/className="row[ "]/);
  expect(debug).not.toContain('embedded ? "row" : "page-head"');
  expect(debug).not.toContain('className="page-head"');
});
