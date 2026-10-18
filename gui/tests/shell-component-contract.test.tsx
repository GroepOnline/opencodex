import { describe, expect, test } from "bun:test";
import { selectionTransition } from "../src/shared/motion/selection-transition";

describe("Signaal selection is reduced-motion and keyboard safe", () => {
  test("suppresses layout travel when preference is true or not resolved", () => {
    expect(selectionTransition(true, false, 0.18)).toEqual({ duration: 0 });
    expect(selectionTransition(null, false, 0.22)).toEqual({ duration: 0 });
    expect(selectionTransition(false, true, 0.18)).toEqual({ duration: 0 });
  });
  test("supports finite retargetable pointer selection in both navigation rails", () => {
    expect(selectionTransition(false, false, 0.18)).toEqual({
      type: "spring", visualDuration: 0.18, bounce: 0,
    });
    expect(selectionTransition(false, false, 0.22)).toEqual({
      type: "spring", visualDuration: 0.22, bounce: 0,
    });
  });
});

test("the shell composes status, header, feedback, content and settings", async () => {
  const shell = await Bun.file(new URL("../src/app/DashboardShell.tsx", import.meta.url)).text();
  const header = await Bun.file(new URL("../src/app/header/ProductHeader.tsx", import.meta.url)).text();
  const status = await Bun.file(new URL("../src/app/use-shell-status.ts", import.meta.url)).text();
  expect(shell).toContain("<ProductHeader");
  expect(shell).toContain("<OfflineBanner");
  expect(shell).toContain("<RouteOutlet");
  expect(shell).not.toContain("useKeyedClientResource");
  expect(header).toContain("<SessionIdentity");
  expect(header).toContain("<ProxyStatus");
  expect(header).toContain("<SettingsTrigger");
  expect(status).toContain('pollMs: 30_000');
  expect(status).toContain("healthPoll.error");
  expect(status).toContain("__APP_VERSION__");
});
