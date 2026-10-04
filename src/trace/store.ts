/**
 * Local trace store (trace.sqlite): optional request/response payloads linked to usage.jsonl rows by
 * `traceId` (= requestId). Bodies are gzip BLOBs with a TTL and a total size cap. Every entry point
 * swallows its own failures: trace capture must never break the proxy.
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { getTraceSettings } from "./settings";
import type { TraceMode, UsageTraceMeta } from "./types";

export interface TraceRow {
  traceId: string;
  createdAt: number;
  mode: TraceMode;
  conversationId?: string;
  provider?: string;
  model?: string;
  status?: number;
  meta: UsageTraceMeta;
  inbound?: string;
  outbound?: string;
  response?: string;
  truncated: boolean;
}

export interface TraceRowSummary {
  traceId: string;
  createdAt: number;
  expiresAt: number;
  mode: TraceMode;
  conversationId?: string;
  provider?: string;
  model?: string;
  status?: number;
  meta: UsageTraceMeta;
  truncated: boolean;
}

const PRUNE_EVERY_WRITES = 100;
const PRUNE_EVERY_MS = 60_000;

let db: Database | null = null;
let dbPath = "";
let writesSincePrune = 0;
let lastPruneAt = 0;

export function traceDbPath(): string {
  return join(getConfigDir(), "trace.sqlite");
}

function openStore(): Database {
  const path = traceDbPath();
  if (db && dbPath === path) return db;
  closeTraceStore();
  const dir = getConfigDir();
  recordOwnedConfigPath(dir, path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }
  const fresh = new Database(path, { create: true });
  // auto_vacuum only takes effect on a new file, before the first table exists.
  fresh.exec("PRAGMA auto_vacuum = INCREMENTAL");
  fresh.exec("PRAGMA journal_mode = WAL");
  fresh.exec("PRAGMA synchronous = NORMAL");
  fresh.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      trace_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      mode TEXT NOT NULL,
      conversation_id TEXT,
      provider TEXT,
      model TEXT,
      status INTEGER,
      meta TEXT NOT NULL,
      inbound BLOB,
      outbound BLOB,
      response BLOB,
      truncated INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS traces_expires ON traces(expires_at);
    CREATE INDEX IF NOT EXISTS traces_conversation ON traces(conversation_id, created_at);
  `);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
  db = fresh;
  dbPath = path;
  return fresh;
}

export function closeTraceStore(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  db = null;
  dbPath = "";
  writesSincePrune = 0;
  lastPruneAt = 0;
}

function pack(text: string | undefined): Uint8Array | null {
  if (text === undefined) return null;
  return Bun.gzipSync(new TextEncoder().encode(text));
}

function unpack(blob: unknown): string | undefined {
  if (!(blob instanceof Uint8Array)) return undefined;
  // bun:sqlite may surface a SharedArrayBuffer-backed view, while gunzipSync
  // requires an owned ArrayBuffer-backed Uint8Array. Copy at this boundary.
  return new TextDecoder().decode(Bun.gunzipSync(Uint8Array.from(blob)));
}

function dbBytes(path: string): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(path + suffix).size;
    } catch {
      /* missing sidecar */
    }
  }
  return total;
}

function deleteExpiredRows(store: Database, now: number): number {
  return store
    .query("DELETE FROM traces WHERE expires_at <= ?")
    .run(now).changes;
}

function compactAfterDelete(store: Database): void {
  store.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.exec("PRAGMA incremental_vacuum");
}

/** Drop expired rows, then oldest rows until the store is under its size cap. Returns rows deleted. */
export function pruneTraces(now = Date.now()): number {
  try {
    const store = openStore();
    const settings = getTraceSettings();
    let deleted = deleteExpiredRows(store, now);
    const capBytes = settings.maxDbMb * 1024 * 1024;
    const path = traceDbPath();
    let guard = 0;
    while (dbBytes(path) > capBytes && guard < 200) {
      guard += 1;
      const changes = store
        .query(
          "DELETE FROM traces WHERE trace_id IN (SELECT trace_id FROM traces ORDER BY created_at ASC LIMIT 50)",
        )
        .run().changes;
      if (changes === 0) break;
      deleted += changes;
      compactAfterDelete(store);
    }
    if (deleted > 0) {
      compactAfterDelete(store);
    }
    lastPruneAt = now;
    writesSincePrune = 0;
    return deleted;
  } catch {
    return 0;
  }
}

/** Persist one trace. Returns false (never throws) when the write failed. */
export function writeTrace(row: TraceRow): boolean {
  try {
    const store = openStore();
    const now = Date.now();
    const settings = getTraceSettings();
    store
      .query(
        `
      INSERT OR REPLACE INTO traces
        (trace_id, created_at, expires_at, mode, conversation_id, provider, model, status, meta, inbound, outbound, response, truncated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        row.traceId,
        row.createdAt,
        now + settings.ttlHours * 3_600_000,
        row.mode,
        row.conversationId ?? null,
        row.provider ?? null,
        row.model ?? null,
        row.status ?? null,
        JSON.stringify(row.meta),
        pack(row.inbound),
        pack(row.outbound),
        pack(row.response),
        row.truncated ? 1 : 0,
      );
    writesSincePrune += 1;
    if (
      writesSincePrune >= PRUNE_EVERY_WRITES ||
      now - lastPruneAt >= PRUNE_EVERY_MS
    )
      pruneTraces(now);
    return true;
  } catch {
    return false;
  }
}

function summaryFromRow(r: Record<string, unknown>): TraceRowSummary {
  return {
    traceId: String(r.trace_id),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    mode: r.mode as TraceMode,
    ...(typeof r.conversation_id === "string"
      ? { conversationId: r.conversation_id }
      : {}),
    ...(typeof r.provider === "string" ? { provider: r.provider } : {}),
    ...(typeof r.model === "string" ? { model: r.model } : {}),
    ...(typeof r.status === "number" ? { status: r.status } : {}),
    meta: JSON.parse(String(r.meta)) as UsageTraceMeta,
    truncated: Number(r.truncated) === 1,
  };
}

/** Read one trace (expired rows are invisible even before the next prune). */
export function readTrace(
  traceId: string,
  now = Date.now(),
):
  | (TraceRowSummary & Pick<TraceRow, "inbound" | "outbound" | "response">)
  | null {
  try {
    if (!existsSync(traceDbPath())) return null;
    const store = openStore();
    if (deleteExpiredRows(store, now) > 0) compactAfterDelete(store);
    const r = store
      .query("SELECT * FROM traces WHERE trace_id = ? AND expires_at > ?")
      .get(traceId, now) as Record<string, unknown> | null;
    if (!r) return null;
    const inbound = unpack(r.inbound);
    const outbound = unpack(r.outbound);
    const response = unpack(r.response);
    return {
      ...summaryFromRow(r),
      ...(inbound !== undefined ? { inbound } : {}),
      ...(outbound !== undefined ? { outbound } : {}),
      ...(response !== undefined ? { response } : {}),
    };
  } catch {
    return null;
  }
}

export function listTraces(
  options: { conversationId?: string; limit?: number; now?: number } = {},
): TraceRowSummary[] {
  try {
    if (!existsSync(traceDbPath())) return [];
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const now = options.now ?? Date.now();
    const store = openStore();
    if (deleteExpiredRows(store, now) > 0) compactAfterDelete(store);
    const rows = (
      options.conversationId
        ? store
            .query(
              "SELECT * FROM traces WHERE expires_at > ? AND conversation_id = ? ORDER BY created_at DESC LIMIT ?",
            )
            .all(now, options.conversationId, limit)
        : store
            .query(
              "SELECT * FROM traces WHERE expires_at > ? ORDER BY created_at DESC LIMIT ?",
            )
            .all(now, limit)
    ) as Record<string, unknown>[];
    return rows.map(summaryFromRow);
  } catch {
    return [];
  }
}
