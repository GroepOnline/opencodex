import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const parent = readFileSync(
  new URL("../src/server/management/agent-settings-routes.ts", import.meta.url),
  "utf8",
);
const route = readFileSync(
  new URL("../src/server/management/claude-code-routes.ts", import.meta.url),
  "utf8",
);

test("Claude Code management remains delegated through the authenticated handler", () => {
  expect(parent).toContain("await handleClaudeCodeRoutes(ctx)");
  expect(parent).not.toContain('url.pathname === "/api/claude-code"');
  expect(route).toContain('url.pathname === "/api/claude-code" && req.method === "GET"');
  expect(route).toContain('url.pathname === "/api/claude-code" && req.method === "PUT"');
});

test("Claude auth-mode migrations and agent registry sync remain paired to persistence", () => {
  expect(route).toContain("authModeMigratedAt = new Date().toISOString()");
  expect(route).toContain("applySystemEnvToggle(config, config.port)");
  expect(route).toContain("await syncClaudeAgentDefsBestEffort()");
  expect(route).toContain("saveConfigPreservingClaudeCode: save");
});
