import { expect, test } from "bun:test";

test("ProviderOverviewDashboard lists unsupported providers alongside quota cards", async () => {
  const src = await Bun.file(new URL("../src/components/provider-workspace/ProviderOverviewDashboard.tsx", import.meta.url)).text();
  expect(src).toContain('card.status === "unsupported"');
  expect(src).not.toContain('card.status === "unsupported") continue');
});

test("Verkeer uses localized unknown labels and local today counting", async () => {
  const src = await Bun.file(new URL("../src/pages/Verkeer.tsx", import.meta.url)).text();
  expect(src).toContain("resolveRequestsToday");
  expect(src).toContain("trafficPrincipalLabel");
  expect(src).toContain("trafficProviderModelLabel");
  expect(src).not.toContain("toISOString().slice(0, 10)");
});
