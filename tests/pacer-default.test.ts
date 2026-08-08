import { describe, expect, it, beforeEach } from "bun:test";
import { configuredCodexPoolSize, resolveEffectivePacing, resetCodexPacerState } from "../src/codex/pacer";

describe("resolveEffectivePacing", () => {
  beforeEach(() => resetCodexPacerState());

  it("returns null when pacing is off and not round-robin multi-account", () => {
    expect(resolveEffectivePacing({ codexRotationMode: undefined }, 1)).toBeNull();
    expect(resolveEffectivePacing({ codexRotationMode: "round-robin" }, 1)).toBeNull();
    expect(resolveEffectivePacing({}, 3)).toBeNull();
  });

  it("counts main plus selectable added accounts for pool width", () => {
    expect(configuredCodexPoolSize({})).toBe(1);
    expect(configuredCodexPoolSize({
      codexAccounts: [
        { id: "acct-a", isMain: false },
        { id: "bad", isMain: true },
      ],
    } as never)).toBe(2);
  });

  it("auto-enables for round-robin + multi-account pool", () => {
    const eff = resolveEffectivePacing({ codexRotationMode: "round-robin" }, 3);
    expect(eff).not.toBeNull();
    expect(eff!.enabled).toBe(true);
    expect(eff!.minMs).toBeGreaterThan(0);
    expect(eff!.maxMs).toBeGreaterThan(eff!.minMs);
  });

  it("auto-enables for accountPoolStrategy round-robin + multi-account", () => {
    const eff = resolveEffectivePacing({ accountPoolStrategy: "round-robin" }, 3);
    expect(eff).not.toBeNull();
    expect(eff!.enabled).toBe(true);
  });

  it("does NOT auto-enable for round-robin with single account", () => {
    expect(resolveEffectivePacing({ codexRotationMode: "round-robin" }, 1)).toBeNull();
    expect(resolveEffectivePacing({ accountPoolStrategy: "round-robin" }, 1)).toBeNull();
  });

  it("respects explicit enabled config", () => {
    const eff = resolveEffectivePacing({ codexRequestPacing: { enabled: true, minMs: 200, maxMs: 400 }, codexRotationMode: undefined }, 1);
    expect(eff).not.toBeNull();
    expect(eff!.enabled).toBe(true);
    expect(eff!.minMs).toBe(200);
    expect(eff!.maxMs).toBe(400);
  });

  it("respects explicit disabled config even for round-robin multi-account", () => {
    // Explicit disabled wins: { enabled: false }
    const eff = resolveEffectivePacing({ codexRequestPacing: { enabled: false }, codexRotationMode: "round-robin" }, 3);
    expect(eff).toBeNull();
    expect(resolveEffectivePacing({
      codexRequestPacing: { enabled: false },
      accountPoolStrategy: "round-robin",
    }, 3)).toBeNull();
  });
});
