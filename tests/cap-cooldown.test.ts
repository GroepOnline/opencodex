import { describe, expect, test } from "bun:test";
import {
  activeProviderCooldowns,
  expireProviderCooldowns,
  isHardCapMessage,
  parseResetsInMs,
  recordProviderCapCooldown,
  resolveProviderConfigKey,
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
