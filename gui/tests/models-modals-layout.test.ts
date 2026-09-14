import { expect, test } from "bun:test";

test("Models modals compose from modal primitives", async () => {
  const source = await Bun.file(
    new URL("../src/pages/models-modals.tsx", import.meta.url),
  ).text();

  expect(source).toContain("<Modal");
  expect(source).toContain("<ModalCard");
  expect(source).toContain("<ModalHead");
  expect(source).toContain("<ModalDesc");
  expect(source).toContain("<ModalActions");
  expect(source).toContain('t("models.v2Label")');
  expect(source).toContain('t("models.customAdd")');
  expect(source).not.toContain('className="modal-overlay"');
  expect(source).not.toContain('className="modal-head"');
});
