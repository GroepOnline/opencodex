import { expect, test } from "bun:test";

test("Codex auth page head composes PageHeader when not embedded", async () => {
  const source = await Bun.file(
    new URL(
      "../src/components/codex-account-pool-main-card.tsx",
      import.meta.url,
    ),
  ).text();
  const header = await Bun.file(
    new URL("../src/components/primitives/page-header.tsx", import.meta.url),
  ).text();

  expect(source).toContain("<PageHeader");
  expect(source).toContain('className="codex-auth-page-head"');
  expect(source).toContain('titleClassName="page-title"');
  expect(source).toContain('actionsClassName="codex-auth-page-head__actions"');
  expect(source).toContain('className="row"');
  expect(source).toContain("codex-auth-page-head__feedback");
  expect(source).not.toContain("page-head codex-auth-page-head");
  expect(source).not.toContain('<h2 className="page-title"');

  expect(header).toContain(
    'className ? `page-head ${className}` : "page-head"',
  );
  expect(header).toContain("actionsClassName");
});
