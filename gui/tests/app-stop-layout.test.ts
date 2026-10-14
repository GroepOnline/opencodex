import { expect, test } from "bun:test";

test("destructive proxy action composes from an accessible alertdialog in the system feature", async () => {
  const shell = await Bun.file(new URL("../src/app/DashboardShell.tsx", import.meta.url)).text();
  const danger = await Bun.file(new URL("../src/features/system/components/DangerZone.tsx", import.meta.url)).text();
  expect(shell).toContain("<DangerZone");
  expect(danger).toContain("<StopProxyDialog");
  expect(danger).toContain("<Modal");
  expect(danger).toContain("<ModalCard");
  expect(danger).toContain("<ModalHead");
  expect(danger).toContain("<ModalDesc");
  expect(danger).toContain("<ModalActions");
  expect(danger).toContain('role="alertdialog"');
  expect(danger).toContain("modal-card--narrow");
  expect(danger).not.toContain('className="modal-overlay"');
});
