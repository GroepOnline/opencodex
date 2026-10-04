/**
 * Trace capture settings.
 *
 * Modes: `off` (default, nothing read or stored), `metadata` (hashes/counts on the usage row only),
 * `redacted` (bodies stored with secrets stripped), `full` (bodies stored verbatim, opt-in).
 * Env: OCX_TRACE, OCX_TRACE_TTL_HOURS, OCX_TRACE_MAX_BODY_BYTES, OCX_TRACE_MAX_DB_MB, OCX_TRACE_SAMPLE.
 */

import type { TraceMode } from "./types";

export type { TraceMode } from "./types";

export const TRACE_MODES: readonly TraceMode[] = [
  "off",
  "metadata",
  "redacted",
  "full",
];

export const TRACE_ENV = {
  mode: "OCX_TRACE",
  ttlHours: "OCX_TRACE_TTL_HOURS",
  maxBodyBytes: "OCX_TRACE_MAX_BODY_BYTES",
  maxDbMb: "OCX_TRACE_MAX_DB_MB",
  sample: "OCX_TRACE_SAMPLE",
} as const;

export interface TraceSettings {
  mode: TraceMode;
  ttlHours: number;
  /** Per-body cap for stored payloads; hashes and byte counts always cover the full body. */
  maxBodyBytes: number;
  maxDbMb: number;
  /** Fraction (0..1) of requests whose bodies are stored in redacted/full mode. */
  sample: number;
}

const DEFAULTS: TraceSettings = {
  mode: "off",
  ttlHours: 24,
  maxBodyBytes: 512 * 1024,
  maxDbMb: 256,
  sample: 1,
};

let override: Partial<TraceSettings> = {};

/** Parse a mode case-insensitively after trimming; return undefined for unrecognized values. */
export function parseTraceMode(value: unknown): TraceMode | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return (TRACE_MODES as readonly string[]).includes(v)
    ? (v as TraceMode)
    : undefined;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Resolve process overrides, then environment values, then defaults on each call.
 * Clamp retention to 1–720 hours, body caps to 4 KiB–8 MiB, database caps to
 * 16–4096 MiB, and sampling to 0–1; round body and database caps down.
 */
export function getTraceSettings(): TraceSettings {
  const mode =
    override.mode ??
    parseTraceMode(process.env[TRACE_ENV.mode]) ??
    DEFAULTS.mode;
  const ttl =
    override.ttlHours ?? envNumber(TRACE_ENV.ttlHours) ?? DEFAULTS.ttlHours;
  const body =
    override.maxBodyBytes ??
    envNumber(TRACE_ENV.maxBodyBytes) ??
    DEFAULTS.maxBodyBytes;
  const db =
    override.maxDbMb ?? envNumber(TRACE_ENV.maxDbMb) ?? DEFAULTS.maxDbMb;
  const sample =
    override.sample ?? envNumber(TRACE_ENV.sample) ?? DEFAULTS.sample;
  return {
    mode,
    ttlHours: clamp(ttl, 1, 720),
    maxBodyBytes: Math.floor(clamp(body, 4 * 1024, 8 * 1024 * 1024)),
    maxDbMb: Math.floor(clamp(db, 16, 4096)),
    sample: clamp(sample, 0, 1),
  };
}

/**
 * Merge process-wide overrides, retaining unspecified fields, and return the
 * resolved settings. Clamping occurs when settings are read.
 */
export function setTraceSettings(
  partial: Partial<TraceSettings>,
): TraceSettings {
  override = { ...override, ...partial };
  return getTraceSettings();
}

export function resetTraceSettingsForTests(): void {
  override = {};
}
