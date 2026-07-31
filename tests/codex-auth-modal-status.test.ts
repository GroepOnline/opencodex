import { describe, expect, test } from "bun:test";
import { localizedCopy } from "./helpers/shipped-locales";

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

  test("defines the new status copy in every shipped GUI locale", () => {
    const resolved = localizedCopy([
      "codexAuth.oauthSubmittingCode",
      "codexAuth.oauthCodeSubmitted",
      "codexAuth.oauthStatusRetrying",
    ]);
    expect(resolved.length).toBeGreaterThan(0);
    for (const { value } of resolved) {
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });
});
