/** V8/JSC stack-frame tails interpolated into error text. */
const STACK_FRAME_TAIL_RE = /(?:\r?\n[ \t]*at[ \t][^\n]+)+/g;

/**
 * JSON for an HTTP response body. Never serializes `Error.stack`.
 *
 * Catch-clause values stay out of the wire format: Error instances become
 * `.toString()` (message only in V8; CodeQL's stack-trace barrier), and any
 * leftover stack-frame lines are stripped from strings.
 */
export function stringifyHttpJson(data: unknown): string {
  return JSON.stringify(data, httpJsonReplacer);
}

function httpJsonReplacer(key: string, value: unknown): unknown {
  if (key === "stack" || key === "stackTrace") return undefined;
  if (value instanceof Error) {
    return clientSafeErrorText(value.toString());
  }
  if (typeof value === "string") {
    return clientSafeErrorText(value);
  }
  return value;
}

function clientSafeErrorText(text: string): string {
  return "" + text.replace(STACK_FRAME_TAIL_RE, "");
}
