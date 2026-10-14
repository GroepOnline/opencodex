import { expect, test } from "bun:test";
import { buildHeatmap, formatPct, lastSevenDays, usagePayloadKey } from "../src/features/usage/model/usage-report";

test("usage snapshots never cross a different API base, range or surface", () => {
  const a = usagePayloadKey("/api-a", "30d", "all");
  expect(a).not.toBe(usagePayloadKey("/api-b", "30d", "all"));
  expect(a).not.toBe(usagePayloadKey("/api-a", "7d", "all"));
  expect(a).not.toBe(usagePayloadKey("/api-a", "30d", "grok"));
});

test("usage heatmap keeps empty activity at zero and handles no server readings", () => {
  const heatmap = buildHeatmap([]);
  expect(heatmap.weeks.length).toBeGreaterThan(0);
  expect(heatmap.weeks.flat().every((cell) => cell.level === 0 && cell.totalTokens === 0)).toBe(true);
  expect(lastSevenDays([])).toHaveLength(7);
  expect(formatPct(0.125)).toBe("13%");
});

test("usage page composes named feature components while owning API polling", async () => {
  const page = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  const markers = [
    "<UsageSummaryCards",
    "<UsageQualityPanel",
    "<UsageHeatmapPanel",
    "<UsageModelsTable",
    "<UsageProvidersTable",
    "<UsageCoveragePanel",
  ];
  let previous = -1;
  for (const marker of markers) {
    const index = page.indexOf(marker);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
  const hook = await Bun.file(new URL("../src/features/usage/hooks/useUsageData.ts", import.meta.url)).text();
  expect(page).toContain("useUsageData({");
  expect(page).not.toContain("fetch(");
  expect(page).not.toContain("setInterval(");
  expect(hook).toContain("controller.abort()");
  expect(hook).toContain("generation === loadGenerationRef.current");
  expect(hook).toContain("lastGoodKeyRef.current !== requestKey");
  expect(page).not.toContain("function UsageSummaryCards");
  expect(page).not.toContain("function UsageQualityPanel");
  expect(page).not.toContain("function UsageModelsTable");
});
