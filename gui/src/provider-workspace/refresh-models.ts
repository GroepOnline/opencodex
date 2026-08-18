/**
 * Operator-forced live /models refresh for one provider.
 * Bypasses the 5-minute catalog TTL and discovery failure cooldown.
 */

export type ProviderModelsRefreshResult =
  | { ok: true; count: number; models: string[]; source?: string }
  | { ok: false; count: number; models: string[]; error: string };

function parseRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

function extractPayload(record: Record<string, unknown>) {
  const models = Array.isArray(record.models)
    ? record.models.filter((id): id is string => typeof id === "string")
    : [];
  const count = typeof record.count === "number" && Number.isFinite(record.count)
    ? record.count
    : models.length;
  const error = typeof record.error === "string" && record.error.trim()
    ? record.error.trim()
    : undefined;
  return { models, count, error };
}

export async function refreshProviderModels(
  apiBase: string,
  provider: string,
): Promise<ProviderModelsRefreshResult> {
  const response = await fetch(
    `${apiBase}/api/providers/models/refresh?name=${encodeURIComponent(provider)}`,
    { method: "POST" },
  );

  if (!response.ok) {
    let record: Record<string, unknown> = {};
    try {
      record = parseRecord(await response.json());
    } catch {
      /* non-JSON error body */
    }
    const { models, count, error } = extractPayload(record);
    return {
      ok: false,
      count,
      models,
      error: error ?? `HTTP ${response.status}`,
    };
  }

  let record: Record<string, unknown>;
  try {
    record = parseRecord(await response.json());
  } catch {
    return {
      ok: false,
      count: 0,
      models: [],
      error: "Invalid JSON response",
    };
  }

  const { models, count, error } = extractPayload(record);
  if (record.ok === false) {
    return {
      ok: false,
      count,
      models,
      error: error ?? "Refresh failed",
    };
  }
  return {
    ok: true,
    count,
    models,
    ...(typeof record.source === "string" ? { source: record.source } : {}),
  };
}
