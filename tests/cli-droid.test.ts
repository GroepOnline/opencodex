import { describe, expect, test } from "bun:test";
import {
  buildDroidSettingsOverlay,
  droidBaseUrl,
  droidCustomModelId,
  droidModelId,
  droidProxyStartArgs,
  fetchDroidModels,
  type DroidRoutedModel,
} from "../src/cli/droid";
import type { OcxConfig } from "../src/types";

function cfg(extra?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: { openai: { adapter: "openai-chat", baseUrl: "http://x/v1" } },
    ...extra,
  } as OcxConfig;
}

const MODELS: DroidRoutedModel[] = [
  {
    provider: "openai",
    id: "openai/gpt-6-astra",
    displayName: "OCX / GPT-6 Astra",
  },
  {
    provider: "zai",
    id: "zai/glm-5.3-flash",
    displayName: "OCX / GLM-5.3 Flash",
  },
];

describe("ocx droid routed model selectors", () => {
  test("preserves provider namespaces for correct proxy routing", () => {
    expect(droidModelId("openai/gpt-6-astra")).toBe("openai/gpt-6-astra");
    expect(droidModelId("zai/glm-5.3-flash")).toBe("zai/glm-5.3-flash");
  });
  test("passes through a bare model id unchanged", () => {
    expect(droidModelId("gpt-5.5")).toBe("gpt-5.5");
  });
  test("preserves nested routing selectors", () => {
    expect(droidModelId("cline-pass/anthropic/claude-haiku-5.5")).toBe(
      "cline-pass/anthropic/claude-haiku-5.5",
    );
  });
});

describe("ocx droid base url", () => {
  test("defaults to the loopback Responses endpoint", () => {
    expect(droidBaseUrl(10123)).toBe("http://127.0.0.1:10123/v1");
  });
  test("uses an explicit origin and strips a trailing slash", () => {
    expect(droidBaseUrl(10100, "https://ocx.chefgroep.online/")).toBe(
      "https://ocx.chefgroep.online/v1",
    );
  });
});

describe("ocx droid model discovery", () => {
  test("starts a proxy without mutating client integrations", () => {
    expect(droidProxyStartArgs(10123)).toEqual([
      "start",
      "--port",
      "10123",
      "--proxy-only",
    ]);
  });

  test("discovers models through the client-visible catalog view", async () => {
    const oldFetch = globalThis.fetch;
    let requestedUrl = "";
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        requestedUrl = String(input instanceof Request ? input.url : input);
        return Response.json([]);
      }) as typeof fetch;
      expect(await fetchDroidModels(10123)).toEqual([]);
      const url = new URL(requestedUrl);
      // The overlay must carry only user-selected models: the same visibility
      // pipeline /v1/models applies for `ocx claude` model discovery.
      expect(url.pathname).toBe("/api/models");
      expect(url.searchParams.get("view")).toBe("client");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("skips native and disabled models while passing image metadata", async () => {
    const oldFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        Response.json([
          {
            provider: "openai",
            id: "gpt-native",
            namespaced: "gpt-native",
            native: true,
          },
          {
            provider: "zai",
            id: "glm",
            namespaced: "zai/glm",
            inputModalities: ["text", "image"],
          },
          { provider: "zai", id: "disabled", disabled: true },
        ])) as typeof fetch;
      expect(await fetchDroidModels(10123)).toEqual([
        {
          provider: "zai",
          id: "zai/glm",
          displayName: undefined,
          inputModalities: ["text", "image"],
        },
      ]);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("does not disguise management authentication failure as an empty model catalog", async () => {
    const oldFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response("secret-diagnostic-must-not-leak", {
          status: 401,
        })) as typeof fetch;
      await expect(fetchDroidModels(10123)).rejects.toThrow(
        "OCX model discovery failed: access denied (HTTP 401)",
      );
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("surfaces unexpected proxy HTTP failures without exposing response bodies", async () => {
    const oldFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response("confidential-upstream-diagnostic", {
          status: 503,
        })) as typeof fetch;
      try {
        await fetchDroidModels(10123);
        throw new Error("expected proxy failure");
      } catch (error) {
        expect((error as Error).message).toBe(
          "OCX model discovery failed: proxy returned HTTP 503",
        );
        expect((error as Error).message).not.toContain("confidential-upstream");
      }
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("rejects malformed catalog responses rather than pretending no models exist", async () => {
    const oldFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        Response.json({ error: "not an array" })) as typeof fetch;
      await expect(fetchDroidModels(10123)).rejects.toThrow(
        "OCX model discovery failed: invalid model catalog response",
      );
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("sanitizes transport failures without leaking the underlying exception", async () => {
    const oldFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        throw new Error("sensitive-network-diagnostic");
      }) as typeof fetch;
      await expect(fetchDroidModels(10123)).rejects.toThrow(
        "OCX model discovery failed: proxy unreachable or request timed out",
      );
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("keeps a successful empty catalog distinct from a failed discovery", async () => {
    const oldFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => Response.json([])) as typeof fetch;
      expect(await fetchDroidModels(10123)).toEqual([]);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("a native-only response has no eligible OCX models", async () => {
    const oldFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        Response.json([
          { provider: "openai", id: "gpt-native", native: true },
        ])) as typeof fetch;
      expect(await fetchDroidModels(10123)).toEqual([]);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});

describe("ocx droid settings overlay (non-destructive BYOK)", () => {
  test("emits stable Factory IDs for each routed proxy model", () => {
    const overlay = buildDroidSettingsOverlay(cfg(), 10123, MODELS);
    expect(overlay.customModels).toHaveLength(2);
    expect(overlay.customModels.map((row) => row.id)).toEqual(
      MODELS.map((row) => droidCustomModelId(row.id)),
    );
    expect(overlay.customModels.map((row) => row.index)).toEqual([0, 1]);
    expect(overlay.customModels.map((row) => row.model)).toEqual([
      "openai/gpt-6-astra",
      "zai/glm-5.3-flash",
    ]);
    expect(
      overlay.customModels.every(
        (row) => row.baseUrl === "http://127.0.0.1:10123/v1",
      ),
    ).toBe(true);
    expect(overlay.customModels.every((row) => row.provider === "openai")).toBe(
      true,
    );
  });

  test("omits apiKey for a keyless loopback endpoint", () => {
    const overlay = buildDroidSettingsOverlay(cfg(), 10123, MODELS);
    expect(Object.hasOwn(overlay.customModels[0], "apiKey")).toBe(false);
  });

  test("uses an environment reference when configured", () => {
    const overlay = buildDroidSettingsOverlay(cfg(), 10123, MODELS, {
      apiKeyRef: "${OCX_ADMISSION_TOKEN}",
    });
    expect(overlay.customModels[0].apiKey).toBe("${OCX_ADMISSION_TOKEN}");
  });

  test("propagates image input support", () => {
    const overlay = buildDroidSettingsOverlay(cfg(), 10123, [
      {
        provider: "vision",
        id: "vision/model",
        inputModalities: ["text", "image"],
      },
      { provider: "text", id: "text/model", inputModalities: ["text"] },
      { provider: "unknown", id: "unknown/model" },
    ]);
    expect(overlay.customModels.map((row) => row.noImageSupport)).toEqual([
      false,
      true,
      true,
    ]);
  });

  test("prefers config.injectionModel when it is present in the catalog", () => {
    const overlay = buildDroidSettingsOverlay(
      cfg({ injectionModel: "zai/glm-5.3-flash" }),
      10123,
      MODELS,
    );
    expect(overlay.model).toBe(droidCustomModelId("zai/glm-5.3-flash"));
  });

  test("falls back to the first row when injectionModel is not in the catalog", () => {
    const overlay = buildDroidSettingsOverlay(
      cfg({ injectionModel: "openai/gpt-5.5" }),
      10123,
      MODELS,
    );
    expect(overlay.model).toBe(droidCustomModelId("openai/gpt-6-astra"));
  });

  test("drops empty ids and synthesizes a display name when none is given", () => {
    const overlay = buildDroidSettingsOverlay(cfg(), 10123, [
      { provider: "openai", id: "" },
      { provider: "openai", id: "openai/gpt-6-luna" },
    ]);
    expect(overlay.customModels).toHaveLength(1);
    expect(overlay.customModels[0].displayName).toBe("OCX / openai/gpt-6-luna");
  });

  test("an empty catalog yields an empty table without throwing (preserves user file)", () => {
    const overlay = buildDroidSettingsOverlay(cfg(), 10123, []);
    expect(overlay.customModels).toEqual([]);
    expect(overlay.model).toBe("");
  });

  test("the overlay carries only model rows — never the user's full settings object", () => {
    const overlay = buildDroidSettingsOverlay(cfg(), 10123, MODELS) as Record<
      string,
      unknown
    >;
    expect(Object.keys(overlay).sort()).toEqual(["customModels", "model"]);
  });
});
