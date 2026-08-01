import { describe, expect, test } from "bun:test";
import {
  activeProviderCooldowns,
  expireProviderCooldowns,
  isHardCapMessage,
  parseResetsInMs,
  recordProviderCapCooldown,
  releaseProviderCooldownDisableOwnership,
  resolveProviderConfigKey,
  startProviderCooldownSweep,
} from "../src/providers/cap-cooldown";
import type { OcxConfig } from "../src/types";

const HOUR_MS = 60 * 60 * 1000;

function bareConfig(overrides?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: { baseUrl: "https://api.openai.com/v1", adapter: "openai-responses" },
      "cline-pass": { baseUrl: "https://api.cline.bot/v1", adapter: "openai-chat" },
    },
    ...overrides,
  } as OcxConfig;
}

describe("parseResetsInMs", () => {
  test("parses Clinepass-style 'resets in 1d 22h'", () => {
    const now = Date.UTC(2026, 6, 31, 0, 0, 0);
    const until = parseResetsInMs("Error 429: You have reached your weekly Clinepass limit. The limit resets in 1d 22h, please try again later.", now);
    expect(until).toBe(now + (1 * 24 + 22) * 60 * 60 * 1000);
  });

  test("parses hours-only", () => {
    const now = 1_000_000;
    expect(parseResetsInMs("resets in 3h", now)).toBe(now + 3 * 60 * 60 * 1000);
  });

  test("returns undefined when no match", () => {
    expect(parseResetsInMs("rate limited, try later")).toBeUndefined();
  });
});

describe("isHardCapMessage", () => {
  test("detects INFERENCE_CAP_ERROR", () => {
    expect(isHardCapMessage(429, '{"code":"INFERENCE_CAP_ERROR","message":"weekly Clinepass limit"}')).toBe(true);
  });

  test("detects weekly limit with parseable reset", () => {
    expect(isHardCapMessage(429, "weekly Clinepass limit. The limit resets in 1d 22h")).toBe(true);
  });

  test("ignores ordinary rate limits", () => {
    expect(isHardCapMessage(429, "Too many requests")).toBe(false);
  });

  test("ignores bare usage-limit without reset window", () => {
    expect(isHardCapMessage(429, "You hit a usage limit, slow down")).toBe(false);
  });

  test("ignores non-429", () => {
    expect(isHardCapMessage(500, "INFERENCE_CAP_ERROR")).toBe(false);
  });
});

describe("recordProviderCapCooldown (live config)", () => {
  test("mutates the given config and disables non-default provider", () => {
    const config = bareConfig();
    const now = Date.UTC(2026, 6, 31, 0, 0, 0);
    const entry = recordProviderCapCooldown(
      config,
      "cline-pass",
      429,
      'Error 429: {"code":"INFERENCE_CAP_ERROR","message":"weekly Clinepass limit. The limit resets in 1d 22h"}',
      { now, save: false },
    );
    expect(entry).not.toBeNull();
    expect(config.providers["cline-pass"]?.disabled).toBe(true);
    expect(config.providerCooldowns?.["cline-pass"]?.disabledProvider).toBe(true);
    expect(config.providerCooldowns?.["cline-pass"]?.until).toBe(now + (1 * 24 + 22) * HOUR_MS);
    expect(activeProviderCooldowns(config, now)["cline-pass"]).toBeTruthy();
  });

  test("does not disable the default provider but still records cooldown", () => {
    const config = bareConfig();
    const now = 1_000_000;
    const entry = recordProviderCapCooldown(
      config,
      "openai",
      429,
      '{"code":"INFERENCE_CAP_ERROR","message":"weekly limit"}',
      { now, save: false },
    );
    expect(entry).not.toBeNull();
    expect(config.providers.openai?.disabled).toBeUndefined();
    expect(entry?.disabledProvider).toBe(false);
  });

  test("resolves openai-<label> log names back to openai", () => {
    const config = bareConfig();
    expect(resolveProviderConfigKey(config, "openai-work")).toBe("openai");
  });

  // `providers` is a plain record, so `config.providers.constructor` is a truthy inherited
  // function. A log label of that name must not resolve as a provider, or the record path
  // would write `disabled` onto Object.prototype's member and persist a phantom cooldown.
  test("inherited Object keys never resolve as provider names", () => {
    const config = bareConfig();
    for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(resolveProviderConfigKey(config, inherited)).toBeNull();
    }
    const cap = 'Error 429: {"code":"INFERENCE_CAP_ERROR","message":"weekly limit. resets in 3h"}';
    expect(recordProviderCapCooldown(config, "constructor", 429, cap, { save: false })).toBeNull();
    expect(config.providerCooldowns).toBeUndefined();
  });

  test("expire re-enables only cooldown-disabled providers", () => {
    const config = bareConfig();
    const past = 1_000;
    config.providers["cline-pass"].disabled = true;
    config.providerCooldowns = {
      "cline-pass": {
        until: past,
        reason: "INFERENCE_CAP_ERROR",
        message: "cap",
        source: "upstream-429",
        disabledProvider: true,
      },
    };
    expect(expireProviderCooldowns(config, past + 1)).toBe(true);
    expect(config.providers["cline-pass"]?.disabled).toBeUndefined();
    expect(config.providerCooldowns).toBeUndefined();
  });
});

describe("cooldown write amplification", () => {
  const CAP_429 = 'Error 429: {"code":"INFERENCE_CAP_ERROR","message":"weekly Clinepass limit. The limit resets in 1d 22h"}';

  test("repeat hard-cap 429s inside an active window neither rewrite nor re-save", () => {
    const config = bareConfig();
    const now = Date.UTC(2026, 6, 31, 0, 0, 0);
    let saves = 0;
    // Stands in for saveConfigPreservingClaudeCode, so this counts the writes the record path
    // actually performs rather than writes the test itself makes.
    const record = (at: number) => recordProviderCapCooldown(config, "cline-pass", 429, CAP_429, {
      now: at,
      save: () => { saves += 1; },
    });

    const first = record(now);
    expect(first?.until).toBe(now + (1 * 24 + 22) * HOUR_MS);

    // A retrying client produces one of these per rejected request for the whole cap window.
    for (let i = 1; i <= 50; i += 1) {
      const again = record(now + i * 60_000);
      expect(again?.until).toBe(first?.until);
      expect(again?.recordedAt).toBe(now);
    }
    expect(saves).toBe(1);
    expect(Object.keys(config.providerCooldowns ?? {})).toEqual(["cline-pass"]);
  });

  test("a materially longer cap still extends the active window", () => {
    const config = bareConfig();
    const now = Date.UTC(2026, 6, 31, 0, 0, 0);
    recordProviderCapCooldown(config, "cline-pass", 429, "weekly limit. resets in 3h", { now, save: false });
    expect(config.providerCooldowns?.["cline-pass"]?.until).toBe(now + 3 * HOUR_MS);

    recordProviderCapCooldown(config, "cline-pass", 429, "weekly limit. resets in 6d", { now, save: false });
    expect(config.providerCooldowns?.["cline-pass"]?.until).toBe(now + 6 * 24 * HOUR_MS);
  });
});

describe("disable ownership", () => {
  test("an explicit operator disable survives cooldown expiry", () => {
    const config = bareConfig();
    const now = 1_000_000;
    recordProviderCapCooldown(
      config,
      "cline-pass",
      429,
      '{"code":"INFERENCE_CAP_ERROR","message":"weekly limit"}',
      { now, save: false },
    );
    expect(config.providers["cline-pass"]?.disabled).toBe(true);

    // The operator turns the provider off by hand while the cap is still active; the
    // management API hands ownership of `disabled` back to them.
    expect(releaseProviderCooldownDisableOwnership(config, "cline-pass")).toBe(true);

    expect(expireProviderCooldowns(config, now + 8 * 24 * HOUR_MS)).toBe(true);
    expect(config.providers["cline-pass"]?.disabled).toBe(true);
    expect(config.providerCooldowns).toBeUndefined();
  });

  test("releasing ownership is a no-op when no cooldown owns the flag", () => {
    const config = bareConfig();
    expect(releaseProviderCooldownDisableOwnership(config, "cline-pass")).toBe(false);
  });

  test("ownership stays claimed when a combined patch would have failed before save", () => {
    // Mirrors the provider-routes contract: release only after validation succeeds.
    // A rejected `{ disabled, baseUrl }` patch must leave disabledProvider true so
    // expiry can still clear the auto-pause.
    const config = bareConfig();
    const now = 1_000_000;
    recordProviderCapCooldown(
      config,
      "cline-pass",
      429,
      '{"code":"INFERENCE_CAP_ERROR","message":"weekly limit"}',
      { now, save: false },
    );
    expect(config.providerCooldowns?.["cline-pass"]?.disabledProvider).toBe(true);
    // Simulate a rejected patch path: never call releaseProviderCooldownDisableOwnership.
    expect(expireProviderCooldowns(config, now + 8 * 24 * HOUR_MS)).toBe(true);
    expect(config.providers["cline-pass"]?.disabled).toBeUndefined();
  });
});

describe("startProviderCooldownSweep", () => {
  test("re-enables a capped provider without any /api/config poll", async () => {
    const config = bareConfig();
    const now = Date.now();
    config.providers["cline-pass"].disabled = true;
    config.providerCooldowns = {
      "cline-pass": {
        until: now - 1,
        reason: "INFERENCE_CAP_ERROR",
        message: "cap",
        source: "upstream-429",
        disabledProvider: true,
      },
    };
    let saves = 0;
    const sweep = startProviderCooldownSweep(config, { intervalMs: 5, save: () => { saves += 1; } });
    try {
      await Bun.sleep(40);
    } finally {
      sweep.stop();
    }
    expect(config.providers["cline-pass"]?.disabled).toBeUndefined();
    expect(config.providerCooldowns).toBeUndefined();
    // Exactly one write: the sweep only saves on the tick that actually mutated config.
    expect(saves).toBe(1);
  });
});
