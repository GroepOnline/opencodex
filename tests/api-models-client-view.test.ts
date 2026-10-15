import { describe, expect, test } from "bun:test";
import { NATIVE_OPENAI_MODELS } from "../src/codex/catalog";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest as Request } from "./helpers/management-auth";
import type { OcxConfig } from "../src/types";

/**
 * `/api/models?view=client` is the catalog view the Droid launcher consumes. It must
 * apply the exact visibility pipeline the data-plane `/v1/models` catalog applies for
 * `ocx claude` model discovery: the per-provider `selectedModels` allowlist, the
 * `disabledModels` blocklist, and provider-death hiding when `hideUnavailableModels`
 * is enabled. The default (admin) view keeps the full last-good catalog.
 */

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      // Disabled so the test never performs live provider discovery; the
      // selectedModels allowlist is read from the persisted config either way.
      zai: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:9/v1",
        disabled: true,
        selectedModels: ["glm-5.3-flash", "glm-blocked"],
      },
    },
    customModels: [
      {
        id: "cm-1",
        provider: "zai",
        modelId: "glm-5.3-flash",
        displayName: "GLM-5.3 Flash",
      },
      {
        id: "cm-2",
        provider: "zai",
        modelId: "glm-5.2",
        displayName: "GLM-5.2",
      },
      {
        id: "cm-3",
        provider: "zai",
        modelId: "glm-blocked",
        displayName: "Blocked",
      },
      // Provider without any allowlist: everything visible stays offered.
      {
        id: "cm-4",
        provider: "free",
        modelId: "big-pickle",
        displayName: "Big Pickle",
      },
    ],
    disabledModels: ["zai/glm-blocked"],
    ...overrides,
  } as OcxConfig;
}

type ModelRow = {
  namespaced: string;
  provider: string;
  id: string;
  disabled?: boolean;
  native?: boolean;
  custom?: boolean;
};

async function getModelRows(
  config: OcxConfig,
  search = "",
): Promise<ModelRow[]> {
  const url = `http://localhost/api/models${search}`;
  const res = await handleManagementAPI(new Request(url), new URL(url), config);
  expect(res?.status).toBe(200);
  const body = await res!.json();
  expect(Array.isArray(body)).toBe(true);
  return body as ModelRow[];
}

function customNames(rows: ModelRow[]): string[] {
  return rows
    .filter((row) => row.custom === true)
    .map((row) => row.namespaced)
    .sort();
}

describe("GET /api/models client view (?view=client)", () => {
  test("admin view (default) keeps the full catalog with explicit disabled flags", async () => {
    const rows = await getModelRows(makeConfig());
    expect(customNames(rows)).toEqual([
      "free/big-pickle",
      "zai/glm-5.2",
      "zai/glm-5.3-flash",
      "zai/glm-blocked",
    ]);
    expect(
      rows.find((row) => row.namespaced === "zai/glm-blocked")?.disabled,
    ).toBe(true);
    expect(
      rows.find((row) => row.namespaced === "zai/glm-5.3-flash")?.disabled,
    ).toBe(false);
  });

  test("client view offers only the user-selected models", async () => {
    const rows = await getModelRows(makeConfig(), "?view=client");
    // glm-5.3-flash: inside the zai allowlist. big-pickle: provider has no allowlist.
    expect(customNames(rows)).toEqual(["free/big-pickle", "zai/glm-5.3-flash"]);
    // The blocklist never reaches the client view even for an allowlisted model.
    expect(
      rows.find((row) => row.namespaced === "zai/glm-blocked"),
    ).toBeUndefined();
    // Native rows still lead the response; their availability handling is unchanged.
    expect(rows[0]?.native).toBe(true);
    expect(
      rows.filter((row) => row.native === true).map((row) => row.namespaced),
    ).toEqual([...NATIVE_OPENAI_MODELS]);
  });

  test("client view hides a dead provider entirely when hideUnavailableModels is on", async () => {
    const rows = await getModelRows(
      makeConfig({ hideUnavailableModels: true }),
      "?view=client",
    );
    // zai is disabled: provider-level death hides every zai row, allowlisted or not.
    expect(customNames(rows)).toEqual(["free/big-pickle"]);
  });

  test("admin view still lists a dead provider's rows when hideUnavailableModels is on", async () => {
    const rows = await getModelRows(
      makeConfig({ hideUnavailableModels: true }),
    );
    expect(customNames(rows)).toEqual([
      "free/big-pickle",
      "zai/glm-5.2",
      "zai/glm-5.3-flash",
      "zai/glm-blocked",
    ]);
  });

  test("an unknown view value falls back to the admin catalog", async () => {
    const rows = await getModelRows(makeConfig(), "?view=admin");
    expect(customNames(rows)).toHaveLength(4);
  });
});
