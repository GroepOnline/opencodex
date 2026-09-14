import { expect, test } from "bun:test";

test("Instellingen composes from modal, setting-row, and segmented primitives", async () => {
  const page = await Bun.file(
    new URL("../src/pages/Instellingen.tsx", import.meta.url),
  ).text();
  const modal = await Bun.file(
    new URL("../src/components/primitives/modal.tsx", import.meta.url),
  ).text();

  expect(page).toContain("<Modal");
  expect(page).toContain("<ModalCard");
  expect(page).toContain("<ModalHead");
  expect(page).toContain("<SettingRow");
  expect(page).toContain("<LanguageSetting");
  expect(page).toContain("<ThemeSetting");
  expect(page).toContain("<SegmentedControl");
  expect(page).toContain("<SegmentedOption");
  expect(page).toContain('className="select-sm"');
  expect(page).toContain('className="usage-segmented"');
  expect(page).not.toContain('role="dialog"');

  expect(modal).toContain('className = "modal-overlay"');
  expect(modal).toContain('className = "modal-card"');
  expect(modal).toContain('className = "modal-head"');
});
