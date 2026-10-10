import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const parent = readFileSync(
  new URL("../src/server/management/agent-settings-routes.ts", import.meta.url),
  "utf8",
);
const desktop = readFileSync(
  new URL("../src/server/management/claude-desktop-routes.ts", import.meta.url),
  "utf8",
);

test("Claude Desktop routes are delegated only through the authenticated management handler", () => {
  expect(parent).toContain("await handleClaudeDesktopRoutes(ctx)");
  expect(parent).not.toContain('url.pathname === "/api/claude-desktop"');
  for (const suffix of ["", "/apply", "/3p-library", "/status"]) {
    expect(desktop).toContain(`"/api/claude-desktop${suffix}"`);
  }
});

test("credential-bearing Desktop library responses keep no-store protection", () => {
  expect(desktop).toContain("readAppliedDesktop3pLibrary()");
  expect(desktop).toContain("withNoStore(jsonResponse(data, status, req, config))");
  expect(desktop).toContain("return noStoreJson(library)");
});
