import { describe, expect, test } from "bun:test";
import {
  addFinalRequestLog,
  applyDataPlaneLogAdmission,
  clearRequestLogsForTests,
  getRequestLogEntries,
  seedLogCtxFromRequestBody,
  type RequestLogContext,
} from "../src/server/request-log";
import type { OcxConfig } from "../src/types";

describe("request log identity on early failures", () => {
  test("addFinalRequestLog keeps requested model and namespaced provider when wire labels were unknown", () => {
    clearRequestLogsForTests();
    const logCtx: RequestLogContext = { model: "unknown", provider: "unknown", requestedModel: "kilo/tencent/hy3:free" };
    addFinalRequestLog("ocx-early", 1_000, logCtx, 499, { closeReason: "client_cancel" });
    const entry = getRequestLogEntries().at(-1)!;
    expect(entry.model).toBe("kilo/tencent/hy3:free");
    expect(entry.provider).toBe("kilo");
  });

  test("seedLogCtxFromRequestBody resolves provider from a namespaced model id", () => {
    const config = {
      defaultProvider: "kilo",
      providers: {
        kilo: { adapter: "openai-chat", baseUrl: "https://example.invalid", apiKey: "k" },
      },
    } as unknown as OcxConfig;
    const logCtx: RequestLogContext = { model: "unknown", provider: "unknown" };
    seedLogCtxFromRequestBody(logCtx, { model: "kilo/tencent/hy3:free" }, config);
    expect(logCtx.requestedModel).toBe("kilo/tencent/hy3:free");
    expect(logCtx.provider).toBe("kilo");
    expect(logCtx.model).toBe("tencent/hy3:free");
  });

  test("applyDataPlaneLogAdmission stamps configured apiKeys[].name as principal", () => {
    const config = {
      apiKeys: [{ name: "kilo", key: "secret-key-value" }],
      providers: {},
    } as unknown as OcxConfig;
    const logCtx: RequestLogContext = { model: "m", provider: "p" };
    const req = new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer secret-key-value" },
    });
    applyDataPlaneLogAdmission(logCtx, req, config);
    expect(logCtx.principal).toBe("kilo");
  });
});
