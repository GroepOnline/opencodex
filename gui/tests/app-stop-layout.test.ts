import { expect, test } from "bun:test";

test("App stop-proxy confirmation composes from modal primitives", async () => {
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

  expect(app).toContain("<DangerZone");
  expect(app).toContain("<StopProxyDialog");
  expect(app).toContain("<Modal");
  expect(app).toContain("<ModalCard");
  expect(app).toContain("<ModalHead");
  expect(app).toContain("<ModalDesc");
  expect(app).toContain("<ModalActions");
  expect(app).toContain('role="alertdialog"');
  expect(app).toContain("modal-card--narrow");
  expect(app).not.toContain('className="modal-overlay"');
});
