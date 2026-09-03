import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { routeModel } from "../../src/router";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";

const azureFoundry: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://example.openai.azure.com/openai/v1",
  models: ["DeepSeek-V4-Pro", "Kimi-K2.6", "gpt-5.6-sol-dz-se"],
};

function parsed(modelId: string, reasoning = "medium", tools: OcxParsedRequest["context"]["tools"] = []): OcxParsedRequest {
  return {
    modelId,
    context: {
      messages: [{ role: "user", content: "compatibility probe", timestamp: 0 }],
      tools,
    },
    stream: false,
    options: { reasoning },
  } as OcxParsedRequest;
}

async function bodyFor(modelId: string, reasoning = "medium", tools: OcxParsedRequest["context"]["tools"] = []) {
  const adapter = createOpenAIChatAdapter(azureFoundry);
  const request = await Promise.resolve(adapter.buildRequest(parsed(modelId, reasoning, tools)));
  return JSON.parse(request.body as string) as Record<string, any>;
}
const automationParameters = {
  oneOf: [
    {
      type: "object",
      properties: { mode: { $ref: "#/$defs/mode" } },
      required: ["mode"],
    },
    {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  ],
  $defs: { mode: { type: "string", enum: ["create", "update"] } },
};

const tool = {
  name: "automation_update",
  description: "Update an automation",
  parameters: automationParameters,
};

const deepSeekBody = await bodyFor("DeepSeek-V4-Pro", "medium", [tool]);
const parameters = deepSeekBody.tools?.[0]?.function?.parameters ?? {};
const forbidden = ["oneOf", "anyOf", "allOf", "enum", "const", "not"];
const forbiddenRootSchemaKeys = forbidden.filter((key) => Object.hasOwn(parameters, key)).length;
const rootSchemaObject = parameters.type === "object" ? 1 : 0;
const transformedToolCount = JSON.stringify(parameters) === JSON.stringify(automationParameters) ? 0 : 1;
const kimiBody = await bodyFor("Kimi-K2.6");
const kimiReasoningWireFields = Number(
  Object.hasOwn(kimiBody, "reasoning_effort")
  || Object.hasOwn(kimiBody, "thinking")
  || Object.hasOwn(kimiBody, "thinking_budget")
  || (typeof kimiBody.reasoning === "object" && kimiBody.reasoning !== null && Object.hasOwn(kimiBody.reasoning, "effort")),
);

const controlBody = await bodyFor("gpt-5.6-sol-dz-se");
const reasoningControlPreserved = Number(
  Object.hasOwn(controlBody, "reasoning_effort")
  || (typeof controlBody.reasoning === "object" && controlBody.reasoning !== null && Object.hasOwn(controlBody.reasoning, "effort")),
);

const routeConfig: OcxConfig = {
  port: 10100,
  defaultProvider: "azure-foundry",
  providers: { "azure-foundry": azureFoundry },
};
const franceRoute = routeModel(routeConfig, "azure-france/Kimi-K2.6");
const azureFranceRouteResolved = Number(franceRoute.providerName === "azure-france" && franceRoute.modelId === "Kimi-K2.6");

const checks = [
  forbiddenRootSchemaKeys === 0,
  rootSchemaObject === 1,
  kimiReasoningWireFields === 0,
  reasoningControlPreserved === 1,
];
const focusedTestFailures = checks.filter((ok) => !ok).length;
const compatSmokePassRate = checks.filter(Boolean).length / checks.length;
console.log(JSON.stringify({
  compat_smoke_pass_rate: compatSmokePassRate,
  forbidden_root_schema_keys: forbiddenRootSchemaKeys,
  root_schema_object: rootSchemaObject,
  kimi_reasoning_wire_fields: kimiReasoningWireFields,
  reasoning_control_preserved: reasoningControlPreserved,
  focused_test_failures: focusedTestFailures,
  transformed_tool_count: transformedToolCount,
  focused_test_count: checks.length,
  azure_france_route_resolved: azureFranceRouteResolved,
}));
