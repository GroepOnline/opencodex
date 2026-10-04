import {
  listTraces,
  readTrace,
  type TraceRowSummary,
} from "../trace/store";
import {
  CliUsageError,
  rejectArgs,
  runCliAction,
  takeFlag,
  takeIntegerOption,
  takeOption,
} from "./runtime-api";

const USAGE = `Usage:
  ocx trace list [--conversation <id>] [--limit <n>] [--json]
  ocx trace show <trace-id> [--body] [--json]

Bodies are never printed unless --body is provided.
Human body output is JSON-escaped so stored terminal control sequences are not executed.`;

type TraceRecord = NonNullable<ReturnType<typeof readTrace>>;

function metadataOnly(row: TraceRecord): TraceRowSummary {
  const { inbound: _inbound, outbound: _outbound, response: _response, ...summary } = row;
  return summary;
}

function formatBytes(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}

function terminalText(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function traceLine(row: TraceRowSummary): string {
  const route = [row.provider, row.model]
    .filter((value): value is string => typeof value === "string")
    .map(terminalText)
    .join("/") || "-";
  return [
    new Date(row.createdAt).toISOString(),
    terminalText(row.traceId),
    row.mode,
    route,
    row.status === undefined ? "-" : String(row.status),
    `req=${formatBytes(row.meta.requestBytes)}B`,
    `out=${formatBytes(row.meta.outboundBytes)}B`,
    `res=${formatBytes(row.meta.responseBytes)}B`,
    row.truncated ? "truncated" : "",
  ].filter(Boolean).join("  ");
}

function printTraceMetadata(row: TraceRowSummary): void {
  console.log(`traceId: ${terminalText(row.traceId)}`);
  console.log(`createdAt: ${new Date(row.createdAt).toISOString()}`);
  console.log(`expiresAt: ${new Date(row.expiresAt).toISOString()}`);
  console.log(`mode: ${row.mode}`);
  console.log(`provider: ${row.provider ? terminalText(row.provider) : "-"}`);
  console.log(`model: ${row.model ? terminalText(row.model) : "-"}`);
  console.log(`status: ${row.status ?? "-"}`);
  console.log(`conversationId: ${row.conversationId ? terminalText(row.conversationId) : "-"}`);
  console.log(`truncated: ${row.truncated ? "yes" : "no"}`);
  console.log(`meta: ${JSON.stringify(row.meta)}`);
}

function printEscapedBody(label: string, value: string | undefined): void {
  console.log(`${label}: ${value === undefined ? "(not captured)" : JSON.stringify(value)}`);
}

function listCommand(argv: string[]): void {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const conversationId = takeOption(args, "--conversation");
  const limit = takeIntegerOption(args, "--limit", { min: 1 }) ?? 50;
  if (limit > 500) throw new CliUsageError("--limit must be between 1 and 500", USAGE);
  rejectArgs(args, USAGE);

  const rows = listTraces({ conversationId, limit });
  if (wantsJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("(no stored traces)");
    return;
  }
  for (const row of rows) console.log(traceLine(row));
}

function showCommand(argv: string[]): void {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const includeBody = takeFlag(args, "--body");
  const traceId = args.shift();
  if (!traceId || traceId.startsWith("-")) {
    throw new CliUsageError("trace show requires a trace id", USAGE);
  }
  rejectArgs(args, USAGE);

  const row = readTrace(traceId);
  if (!row) throw new Error(`trace not found or expired: ${traceId}`);

  const output = includeBody ? row : metadataOnly(row);
  if (wantsJson) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  printTraceMetadata(metadataOnly(row));
  if (!includeBody) return;
  console.log("");
  printEscapedBody("inbound", row.inbound);
  printEscapedBody("outbound", row.outbound);
  printEscapedBody("response", row.response);
}

export async function handleTraceCommand(argv: string[]): Promise<number> {
  return runCliAction(async () => {
    const [sub = "list", ...rest] = argv;
    if (sub === "list") listCommand(rest);
    else if (sub === "show") showCommand(rest);
    else throw new CliUsageError(`unknown trace command ${sub}`, USAGE);
  });
}

export const TRACE_USAGE = USAGE;
