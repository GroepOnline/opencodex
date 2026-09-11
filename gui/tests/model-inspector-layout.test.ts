import { expect, test } from "bun:test";

test("ModelInspector composes from inspector and metric primitives", async () => {
  const page = await Bun.file(
    new URL("../src/pages/ModelInspector.tsx", import.meta.url),
  ).text();
  const inspector = await Bun.file(
    new URL("../src/components/primitives/inspector.tsx", import.meta.url),
  ).text();

  expect(page).toContain("<Inspector");
  expect(page).toContain("<InspectorHeading");
  expect(page).toContain("<InspectorActions");
  expect(page).toContain("<MetricGroup");
  expect(page).toContain("<Metric");
  expect(page).toContain('id="model-inspector"');
  expect(page).toContain('className="model-inspector"');
  expect(page).not.toContain("<aside");

  expect(inspector).toContain("<aside");
  expect(inspector).toContain('className = "inspector"');
  expect(inspector).toContain("aria-label={label}");
});

test("ModelInspector keeps the existing CSS class contracts", async () => {
  const page = await Bun.file(
    new URL("../src/pages/ModelInspector.tsx", import.meta.url),
  ).text();

  for (const marker of [
    "model-inspector-back",
    "model-inspector-heading",
    "model-inspector-provider",
    "model-inspector-identifier",
    "model-inspector-facts",
    "model-inspector-visibility",
    "model-inspector-provenance",
    "model-inspector-actions",
    "model-inspector-empty",
  ]) {
    expect(page).toContain(marker);
  }
});
