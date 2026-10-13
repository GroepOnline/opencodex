import { describe, expect, test } from "bun:test";
import {
  buildDroidSettingsOverlay,
  droidAdmissionEnvironment,
} from "../src/cli/droid";
import type { OcxConfig } from "../src/types";

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {
    openai: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:10100/v1" },
  },
} as OcxConfig;

describe("ocx droid secret-free data-plane admission", () => {
  test("forwards explicit OCX child credential as an env reference, never in the overlay", () => {
    const original = {
      OCX_ADMISSION_TOKEN: "explicit-data-plane-fixture",
      OPENCODEX_API_AUTH_TOKEN: "default-data-plane-fixture",
      OPENCODEX_ADMIN_AUTH_TOKEN: "management-token-must-not-leak",
    };
    const before = { ...original };
    const admission = droidAdmissionEnvironment(config, original);
    const overlay = buildDroidSettingsOverlay(
      config,
      10100,
      [{ provider: "zai", id: "zai/glm-5.3-flash" }],
      { apiKeyRef: admission.apiKeyRef },
    );
    expect(admission.apiKeyRef).toBe("${OCX_ADMISSION_TOKEN}");
    expect(admission.env.OCX_ADMISSION_TOKEN).toBe(
      original.OCX_ADMISSION_TOKEN,
    );
    expect(admission.env.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();
    expect(original).toEqual(before);
    expect(JSON.stringify(overlay)).toContain("${OCX_ADMISSION_TOKEN}");
    expect(JSON.stringify(overlay)).not.toContain(
      "explicit-data-plane-fixture",
    );
    expect(JSON.stringify(overlay)).not.toContain(
      "management-token-must-not-leak",
    );
  });

  test("uses the standard OCX data-plane credential when explicit override is absent", () => {
    const original = {
      OPENCODEX_API_AUTH_TOKEN: "existing-data-plane-fixture",
      OPENCODEX_ADMIN_AUTH_TOKEN: "admin-is-not-data-plane",
    };
    const admission = droidAdmissionEnvironment(config, original);
    expect(admission.env.OCX_ADMISSION_TOKEN).toBe(
      "existing-data-plane-fixture",
    );
    expect(admission.apiKeyRef).toBe("${OCX_ADMISSION_TOKEN}");
    expect(original).not.toHaveProperty("OCX_ADMISSION_TOKEN");
  });

  test("never uses a management-only token to authenticate Factory inference", () => {
    const adminOnly = { OPENCODEX_ADMIN_AUTH_TOKEN: "management-only" };
    const admission = droidAdmissionEnvironment(config, adminOnly);
    expect(admission.apiKeyRef).toBeUndefined();
    expect(admission.env.OCX_ADMISSION_TOKEN).toBeUndefined();
    expect(admission.env.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();
    expect(admission.env).toEqual({});
    expect(adminOnly).toEqual({
      OPENCODEX_ADMIN_AUTH_TOKEN: "management-only",
    });
  });

  test("retains ordinary launch environment without exporting management auth", () => {
    const original = {
      OPENCODEX_ADMIN_AUTH_TOKEN: "admin-must-stay-private",
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
    };
    const snapshot = { ...original };
    const admission = droidAdmissionEnvironment(config, original);
    expect(admission.env).toEqual({
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
    });
    expect(original).toEqual(snapshot);
  });

  test("accepts a configured data-plane API key without mutating config or parent env", () => {
    const withApiKeys = {
      ...config,
      apiKeys: [{ key: "configured-data-plane-fixture" }],
    } as OcxConfig;
    const original = { OPENCODEX_ADMIN_AUTH_TOKEN: "management-only" };
    const admission = droidAdmissionEnvironment(withApiKeys, original);
    expect(admission.env.OCX_ADMISSION_TOKEN).toBe(
      "configured-data-plane-fixture",
    );
    expect(admission.apiKeyRef).toBe("${OCX_ADMISSION_TOKEN}");
    expect(original).not.toHaveProperty("OCX_ADMISSION_TOKEN");
  });
});
