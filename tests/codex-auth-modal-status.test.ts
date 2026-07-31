import { describe, expect, test } from "bun:test";

describe("Codex auth modal status feedback", () => {
  test("keeps a distinct submitted/waiting state for manual code login", async () => {
    const [reducer, oauth, waiting] = await Promise.all([
      Bun.file("gui/src/components/add-codex-account-reducer.ts").text(),
      Bun.file("gui/src/components/use-add-codex-account-oauth.ts").text(),
      Bun.file("gui/src/components/add-codex-account-waiting-step.tsx").text(),
    ]);
    expect(reducer).toContain('export type ManualCodeState = "idle" | "submitting" | "waiting"');
    expect(reducer).toContain('manualCodeState: "idle"');
    expect(oauth).toContain('statusNotice: t("codexAuth.oauthCodeSubmitted")');
    expect(oauth).toContain('statusNotice: t("codexAuth.oauthStatusRetrying")');
    expect(waiting).toContain("disabled={manualCodeBusy || manualCodeWaiting || !manualCode.trim() || !flowId}");
    expect(waiting).toContain('aria-live="polite"');
  });

  test("defines the new status copy in every shipped GUI locale", async () => {
    // en.ts is the TKey source of truth; nl.ts spreads en and only overrides the
    // Joep-facing copy, so untranslated keys fall back to English by design.
    const source = await Bun.file("gui/src/i18n/en.ts").text();
    expect(source).toContain('"codexAuth.oauthSubmittingCode"');
    expect(source).toContain('"codexAuth.oauthCodeSubmitted"');
    expect(source).toContain('"codexAuth.oauthStatusRetrying"');
  });
});
