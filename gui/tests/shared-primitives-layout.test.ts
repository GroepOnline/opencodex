import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const primitivesDir = join(root, "src/components/primitives");

function read(name: string): string {
  return readFileSync(join(primitivesDir, name), "utf8");
}

describe("shared GUI primitives scaffold", () => {
  test("PageHeader keeps named slots for page-specific class contracts", () => {
    const source = read("page-header.tsx");
    expect(source).toContain("titleClassName");
    expect(source).toContain("descriptionClassName");
    expect(source).toContain("actionsClassName");
    expect(source).toContain('"page-head-actions"');
    expect(source).toContain('className = "page-sub"');
    expect(source).toContain("export function PageSubtitle");
  });

  test("PageTabs keep default page-tab classes while allowing overrides", () => {
    const source = read("page-tabs.tsx");
    expect(source).toContain('className = "page-tabs"');
    expect(source).toContain("page-tab--active");
    expect(source).toContain("className?: string");
    expect(source).toContain("style?: CSSProperties");
    expect(source).toContain("hidden?: boolean");
  });

  test("CollapsibleGroup preserves the ocx-group class contract", () => {
    const source = read("collapsible-group.tsx");
    expect(source).toContain("ocx-group-stack");
    expect(source).toContain("ocx-group-head");
    expect(source).toContain("ocx-group-toggle");
    expect(source).toContain("ocx-group-heading");
    expect(source).toContain("ocx-group-name");
    expect(source).toContain("ocx-group-count");
  });

  test("ProfileBar preserves the claude profile bar class contract", () => {
    const source = read("profile-bar.tsx");
    expect(source).toContain("claude-profile-bar");
    expect(source).toContain("claude-dirty");
    expect(source).toContain("claude-save-actions");
  });
});
