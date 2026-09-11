import { expect, test } from "bun:test";

test("workspace dialogs compose from modal primitives", async () => {
  const addProvider = await Bun.file(
    new URL("../src/components/AddProviderModal.tsx", import.meta.url),
  ).text();
  const addCodex = await Bun.file(
    new URL("../src/components/AddCodexAccountModal.tsx", import.meta.url),
  ).text();
  const oauthTos = await Bun.file(
    new URL("../src/components/OAuthTosWarningModal.tsx", import.meta.url),
  ).text();
  const addCombo = await Bun.file(
    new URL("../src/components/combo-workspace-add-modal.tsx", import.meta.url),
  ).text();
  const comboDialogs = await Bun.file(
    new URL("../src/components/combo-workspace-dialogs.tsx", import.meta.url),
  ).text();
  const switchAccount = await Bun.file(
    new URL(
      "../src/components/codex-account-switch-modal.tsx",
      import.meta.url,
    ),
  ).text();
  const resetAccount = await Bun.file(
    new URL("../src/components/codex-account-reset-modal.tsx", import.meta.url),
  ).text();
  const pickStep = await Bun.file(
    new URL(
      "../src/components/add-codex-account-pick-step.tsx",
      import.meta.url,
    ),
  ).text();
  const waitingStep = await Bun.file(
    new URL(
      "../src/components/add-codex-account-waiting-step.tsx",
      import.meta.url,
    ),
  ).text();
  const modal = await Bun.file(
    new URL("../src/components/primitives/modal.tsx", import.meta.url),
  ).text();

  expect(addProvider).toContain("<Modal");
  expect(addProvider).toContain("<ModalCard");
  expect(addProvider).toContain("<ModalHead");
  expect(addProvider).not.toContain('className="modal-overlay"');
  expect(addProvider).not.toContain('className="modal-head"');

  expect(addCodex).toContain("<ModalDialog");
  expect(addCodex).toContain("<ModalCard");
  expect(addCodex).not.toContain("<dialog");
  expect(addCodex).not.toContain('className="modal-overlay"');

  expect(oauthTos).toContain("<ModalDialog");
  expect(oauthTos).toContain("<ModalBackdrop");
  expect(oauthTos).toContain("<ModalCard");
  expect(oauthTos).toContain("<ModalDesc");
  expect(oauthTos).toContain("<ModalActions");
  expect(oauthTos).not.toContain('className="modal-overlay"');
  expect(oauthTos).not.toContain('className="modal-backdrop-dismiss"');

  expect(addCombo).toContain("<ModalDialog");
  expect(addCombo).toContain("<ModalBackdrop");
  expect(addCombo).toContain("<ModalCard");
  expect(addCombo).toContain('className="cwi-modal-actions"');
  expect(addCombo).not.toContain("<dialog");

  expect(comboDialogs).toContain("<ModalDialog");
  expect(comboDialogs).toContain("<ModalBackdrop");
  expect(comboDialogs).toContain(
    'className="modal-card pwi-remove-confirm-card"',
  );
  expect(comboDialogs).toContain('className="pwi-remove-confirm-actions"');
  expect(comboDialogs).toContain('className="pwi-json-unsaved-actions"');
  expect(comboDialogs).not.toContain("<dialog");

  expect(switchAccount).toContain("<ModalDialog");
  expect(switchAccount).toContain("<ModalDesc");
  expect(switchAccount).toContain("<ModalActions");
  expect(switchAccount).not.toContain("<dialog");

  expect(resetAccount).toContain("<ModalDialog");
  expect(resetAccount).toContain("<ModalDesc");
  expect(resetAccount).toContain("<ModalActions");
  expect(resetAccount).not.toContain("<dialog");

  expect(pickStep).toContain("<ModalDesc");
  expect(pickStep).not.toContain('className="modal-desc"');
  expect(waitingStep).toContain("<ModalDesc");
  expect(waitingStep).not.toContain('className="modal-desc"');

  expect(modal).toContain("ref?: Ref<HTMLDivElement>");
});
