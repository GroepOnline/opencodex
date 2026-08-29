import { expect, test } from "bun:test";

test("landing returns before the dashboard health resource is mounted", async () => {
  const source = await Bun.file(
    new URL("../src/App.tsx", import.meta.url),
  ).text();
  const landingGuard = source.indexOf('if (route.view === "landing")');
  const shellCall = source.indexOf("<DashboardShell");
  const shell = source.indexOf("function DashboardShell");
  const healthResource = source.indexOf(
    "const healthPoll = useKeyedClientResource",
    shell,
  );

  expect(landingGuard).toBeGreaterThan(-1);
  expect(shellCall).toBeGreaterThan(landingGuard);
  expect(shell).toBeGreaterThan(shellCall);
  expect(healthResource).toBeGreaterThan(shell);

  const landingBlock = source.slice(landingGuard, shellCall);
  expect(landingBlock).toContain("<ErrorBoundary");
  expect(landingBlock).toContain("<Suspense");
  expect(landingBlock.indexOf("<ErrorBoundary")).toBeLessThan(
    landingBlock.indexOf("<Suspense"),
  );
  expect(landingBlock).not.toContain("useKeyedClientResource");
});
