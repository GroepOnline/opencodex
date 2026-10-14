import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import UsageHeatmapPanel from "../src/features/usage/components/UsageHeatmapPanel";
import { buildHeatmap, lastSevenDays, type UsageDay } from "../src/features/usage/model/usage-report";
import type { TFn } from "../src/i18n/shared";

const t = ((key: string, params?: Record<string, string | number>) =>
  `${key}${params ? `:${Object.values(params).join(",")}` : ""}`) as TFn;
const today = new Date();
const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
const day: UsageDay = { date, requests: 2, measuredRequests: 2, reportedRequests: 2, totalTokens: 120, models: [] };
const days = [day];

test("long-range heatmap offers a keyboard-readable daily data table, not only pixels", () => {
  const html = renderToStaticMarkup(
    <UsageHeatmapPanel range="30d" heatmap={buildHeatmap(days)} weekBars={lastSevenDays(days)} locale="en" t={t} />,
  );
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain("<details");
  expect(html).toContain("<summary");
  expect(html).toContain("<table");
  expect(html).toContain('scope="row"');
  expect(html).toContain(date);
  expect(html).toContain("120");
});

test("seven-day bars expose a focusable button for each date and its actual totals", () => {
  const html = renderToStaticMarkup(
    <UsageHeatmapPanel range="7d" heatmap={buildHeatmap(days)} weekBars={lastSevenDays(days)} locale="nl" t={t} />,
  );
  expect(html).toContain('role="group"');
  expect(html).not.toContain('role="img"');
  expect((html.match(/type="button"/g) ?? []).length).toBe(7);
  expect(html).toContain(`aria-label="${date}: usage.heatmap.tooltipTokens:120, usage.heatmap.tooltipRequests:2"`);
});
