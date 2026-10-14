import { expect, test } from "bun:test";

test("Claude Code's project MCP starts official shadcn from gui's components root", async () => {
  const root = JSON.parse(await Bun.file(new URL("../../.mcp.json", import.meta.url)).text());
  const server = root.mcpServers?.shadcn;
  expect(server).toEqual({ command: "sh", args: ["gui/scripts/shadcn-mcp.sh"] });

  const launcher = await Bun.file(new URL("../scripts/shadcn-mcp.sh", import.meta.url)).text();
  expect(launcher).toContain('cd "$gui_dir"');
  expect(launcher).toContain("shadcn@4.21.4 mcp");
  expect(launcher).toContain('gui_dir="$(CDPATH= cd --');
});

test("shadcn source stays bound to existing Base UI and Signaal primitives", async () => {
  const cfg = JSON.parse(await Bun.file(new URL("../components.json", import.meta.url)).text());
  expect(cfg.style).toBe("base-nova");
  expect(cfg.rsc).toBe(false);
  expect(cfg.tailwind.css).toBe("src/styles/primitives.css");
  expect(cfg.aliases.ui).toBe("@/components/primitives");
  expect(cfg.iconLibrary).toBe("lucide");
});
