import { expect, test } from "bun:test";

test("Verkeer composes from page, strip, panel, and timestamp primitives", async () => {
  const page = await Bun.file(
    new URL("../src/pages/Verkeer.tsx", import.meta.url),
  ).text();
  const ops = await Bun.file(
    new URL("../src/ops-panels.tsx", import.meta.url),
  ).text();
  const strip = await Bun.file(
    new URL("../src/components/primitives/stat-strip.tsx", import.meta.url),
  ).text();

  expect(page).toContain("<PageHeader");
  expect(page).toContain("<TrafficStatsStrip");
  expect(page).toContain("<ProviderShareTable");
  expect(page).toContain("<ModelShareTable");
  expect(page).toContain("<TrafficProviderFilters");
  expect(page).toContain("<SegmentedControl");
  expect(page).toContain("<Timestamp");
  expect(page).toContain("<Panel");
  expect(page).toContain("<PanelHeader");
  expect(page).not.toContain("depas-");
  expect(page).not.toContain("function tijd(");

  expect(ops).toContain("<StatStrip");
  expect(ops).toContain("<StatStripItem");
  expect(ops).toContain('className="tbl"');
  expect(ops).not.toContain("depas-");

  expect(strip).toContain('className = "stat-strip"');
  expect(strip).toContain("stat-strip-waarde");
  expect(strip).toContain("stat-strip-label");
});

test("orphaned De Pas class names stay out of the GUI source", async () => {
  const files = [
    "../src/pages/Verkeer.tsx",
    "../src/ops-panels.tsx",
    "../src/App.tsx",
    "../src/styles.css",
  ];
  for (const relative of files) {
    const src = await Bun.file(new URL(relative, import.meta.url)).text();
    expect(src).not.toContain("depas-");
  }
});
