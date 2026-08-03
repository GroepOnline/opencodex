export interface ExternalModelRow {
  id: string;
  displayName: string;
  provider: string;
  disabled?: boolean;
  native?: boolean;
  custom?: boolean;
}

/** Inbound gateway protocols — not inferred from provider type. */
export function gatewayInboundProtocols(claudeCodeEnabled: boolean): string[] {
  return claudeCodeEnabled
    ? ["responses", "chat", "messages"]
    : ["responses", "chat"];
}

/**
 * Classify a `/v1/models` row. Bare IDs keep their callable id; `owned_by`
 * decides native/combo/custom so combo aliases are not labeled OpenAI.
 */
export function classifyExternalModel(row: {
  id: string;
  owned_by?: string;
}): ExternalModelRow {
  const slashIndex = row.id.indexOf("/");
  const ownedBy = typeof row.owned_by === "string" && row.owned_by.trim()
    ? row.owned_by.trim()
    : undefined;
  const provider = slashIndex > 0
    ? row.id.slice(0, slashIndex)
    : (ownedBy ?? "openai");
  const native = slashIndex < 0 && provider === "openai";
  const custom = provider !== "openai" && provider !== "combo";
  return {
    id: row.id,
    displayName: row.id,
    provider,
    native,
    custom,
  };
}

export function externalModelId(model: ExternalModelRow): string {
  return model.id;
}

/**
 * Map a management `/api/models` row to the external catalog shape. Fallback for
 * when the data-plane `/v1/models` requires a credential the GUI does not hold
 * (non-loopback binds authenticate the dashboard with a management session, which
 * the data plane rejects by design). Rows external clients cannot call (disabled
 * or client-hidden) return null. `namespaced` carries the callable slug
 * (alias-first, same precedence as the public list).
 */
export function externalModelFromAdminRow(row: unknown): ExternalModelRow | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.namespaced !== "string" || !r.namespaced) return null;
  if (r.disabled === true || r.clientHidden === true) return null;
  const classified = classifyExternalModel({
    id: r.namespaced,
    owned_by: typeof r.provider === "string" ? r.provider : undefined,
  });
  return typeof r.displayName === "string" && r.displayName.trim()
    ? { ...classified, displayName: r.displayName }
    : classified;
}
