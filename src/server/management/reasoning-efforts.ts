/** Normalize the UI-supported custom-model reasoning ladder before persistence. */
const VALID = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

export function normalizeReasoningEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((effort): effort is string =>
    typeof effort === "string" && VALID.has(effort),
  ))];
}
