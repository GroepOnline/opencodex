import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import UsageQualityPanel from "../src/features/usage/components/UsageQualityPanel";
import type { UsageSummaryTotals } from "../src/features/usage/model/usage-report";
import type { TFn } from "../src/i18n/shared";

const t = ((key: string) => key) as TFn;
const summary: UsageSummaryTotals = {
  requests: 2,
  measuredRequests: 2,
  reportedRequests: 2,
  unreportedRequests: 0,
  unsupportedRequests: 0,
  estimatedRequests: 0,
  inputTokens: 12,
  outputTokens: 4,
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 16,
  coverageRatio: 1,
};

function qualityValues(source: UsageSummaryTotals): string[] {
  const html = renderToStaticMarkup(<UsageQualityPanel summary={source} t={t} />);
  return [...html.matchAll(/class="stat-value[^"]*">([^<]*)<\/div>/g)].map((match) =>
    match[1].replaceAll("&mdash;", "—").replaceAll("&#x2014;", "—"),
  );
}

test("missing optional quality metrics remain unknown, never display fabricated zeroes", () => {
  expect(qualityValues(summary)).toEqual(["—", "—", "—", "—", "—"]);
});

test("actual zero ratios and latency are still shown as measured zero", () => {
  expect(qualityValues({
    ...summary,
    p95LatencyMs: 0,
    p95TtftMs: 0,
    cacheReadRatio: 0,
    ratio429: 0,
    ratio502: 0,
  })).toEqual(["0ms", "0ms", "0%", "0%", "0%"]);
});
