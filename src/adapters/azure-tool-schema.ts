import type { IncomingMeta, ProviderAdapter } from "./base";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";

const FORBIDDEN_ROOT_KEYS = new Set([
  "oneOf",
  "anyOf",
  "allOf",
  "enum",
  "const",
  "not",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAzureResponsesEndpoint(provider: OcxProviderConfig): boolean {
  try {
    return new URL(provider.baseUrl).hostname.endsWith(".openai.azure.com");
  } catch {
    return false;
  }
}

function mergeProperty(
  target: Record<string, unknown>,
  name: string,
  incoming: unknown,
  composition: "anyOf" | "allOf" = "anyOf",
): void {
  const current = target[name];
  if (
    current === undefined ||
    JSON.stringify(current) === JSON.stringify(incoming)
  ) {
    target[name] = incoming;
    return;
  }
  target[name] = { [composition]: [current, incoming] };
}

function normalizeRootSchema(schema: unknown): Record<string, unknown> {
  const root = isRecord(schema) ? schema : {};
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();

  if (isRecord(root.properties)) {
    for (const [name, child] of Object.entries(root.properties)) {
      mergeProperty(properties, name, child);
    }
  }
  if (Array.isArray(root.required)) {
    for (const name of root.required) {
      if (typeof name === "string") required.add(name);
    }
  }

  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = root[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const normalized = normalizeRootSchema(branch);
      if (isRecord(normalized.properties)) {
        for (const [name, child] of Object.entries(normalized.properties)) {
          mergeProperty(
            properties,
            name,
            child,
            key === "allOf" ? "allOf" : "anyOf",
          );
        }
      }
      if (key === "allOf" && Array.isArray(normalized.required)) {
        for (const name of normalized.required) {
          if (typeof name === "string") required.add(name);
        }
      }
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (
      FORBIDDEN_ROOT_KEYS.has(key) ||
      key === "type" ||
      key === "properties" ||
      key === "required"
    )
      continue;
    out[key] = value;
  }

  out.type = "object";
  if (Object.keys(properties).length > 0) out.properties = properties;
  if (required.size > 0) out.required = [...required];
  return out;
}

function normalizeTool(tool: unknown): unknown {
  if (!isRecord(tool)) return tool;
  let changed = false;
  let parameters = tool.parameters;

  if (tool.type === "function") {
    const normalized = normalizeRootSchema(tool.parameters);
    if (JSON.stringify(normalized) !== JSON.stringify(tool.parameters)) {
      parameters = normalized;
      changed = true;
    }
  }

  let nestedTools = tool.tools;
  if (Array.isArray(tool.tools)) {
    const original = tool.tools;
    const normalized = original.map(normalizeTool);
    if (normalized.some((entry, index) => entry !== original[index])) {
      nestedTools = normalized;
      changed = true;
    }
  }

  return changed
    ? {
        ...tool,
        ...(tool.type === "function" ? { parameters } : {}),
        ...(Array.isArray(tool.tools) ? { tools: nestedTools } : {}),
      }
    : tool;
}

function normalizeBody(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(parsed)) return body;

  let changed = false;
  let tools = parsed.tools;
  if (Array.isArray(parsed.tools)) {
    const original = parsed.tools;
    const normalized = original.map(normalizeTool);
    if (normalized.some((entry, index) => entry !== original[index])) {
      tools = normalized;
      changed = true;
    }
  }

  let additionalTools = parsed.additional_tools;
  if (Array.isArray(parsed.additional_tools)) {
    const original = parsed.additional_tools;
    const normalized = original.map(normalizeTool);
    if (normalized.some((entry, index) => entry !== original[index])) {
      additionalTools = normalized;
      changed = true;
    }
  }

  let input = parsed.input;
  if (Array.isArray(parsed.input)) {
    let inputChanged = false;
    const normalizedInput = parsed.input.map((item) => {
      if (!isRecord(item) || !Array.isArray(item.tools)) return item;
      const original = item.tools;
      const normalized = original.map(normalizeTool);
      if (!normalized.some((entry, index) => entry !== original[index]))
        return item;
      inputChanged = true;
      return { ...item, tools: normalized };
    });
    if (inputChanged) {
      input = normalizedInput;
      changed = true;
    }
  }

  return changed
    ? JSON.stringify({
        ...parsed,
        ...(Array.isArray(parsed.tools) ? { tools } : {}),
        ...(Array.isArray(parsed.additional_tools)
          ? { additional_tools: additionalTools }
          : {}),
        ...(Array.isArray(parsed.input) ? { input } : {}),
      })
    : body;
}

export function withAzureResponsesToolSchemaCompat<T extends ProviderAdapter>(
  provider: OcxProviderConfig,
  adapter: T,
): T {
  if (!isAzureResponsesEndpoint(provider)) return adapter;

  return {
    ...adapter,
    async buildRequest(parsed: OcxParsedRequest, incoming?: IncomingMeta) {
      const request = await adapter.buildRequest(parsed, incoming);
      return { ...request, body: normalizeBody(request.body) };
    },
  } as T;
}
