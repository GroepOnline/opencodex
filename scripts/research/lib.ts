import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Direction = "lower" | "higher";
export type Verdict = "improved" | "no-change" | "regressed" | "guard-failed";
export type TargetStatus = "ready" | "analysis-only" | "blocked";

/** Process exit codes of `run.ts`. Only `improved` means "keep the change". */
export const EXIT = {
  improved: 0,
  error: 1,
  noChange: 2,
  regressed: 3,
  guardFailed: 4,
} as const;

/** Paths no target may ever make mutable: the harness itself and release/automation surface. */
export const ALWAYS_FROZEN = [
  "scripts/research/",
  "tests/research-harness.test.ts",
  ".github/",
  "scripts/release.ts",
  "package.json",
  "bun.lock",
  "bun.lockb",
  ".gitmodules",
  ".gitignore",
] as const;

export interface TargetConfig {
  schema: 1;
  id: string;
  status: TargetStatus;
  description: string;
  metric: { name: string; unit: string; direction: Direction };
  /** argv of the measurement command, run from the repository root. `bun` means the current Bun binary. */
  measure: string[];
  runs: number;
  /** Minimum relative improvement (percent) before a change counts as real. */
  minImprovementPct: number;
  timeoutMs: number;
  /** The only paths an optimizing agent may change. A trailing `/` means a directory prefix. */
  mutable: string[];
  /** Held-out evaluation inputs. Hashed at baseline time and re-checked on every run. */
  fixtures: string[];
  /** Substrings mutable code must not contain (prevents reading held-out fixtures or the harness). */
  forbiddenInMutable: string[];
  /** Commands that must all exit 0 for a change to be kept. */
  guards: string[][];
  notes?: string;
}

export interface Measurement {
  value: number;
  details: Record<string, unknown>;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface BoundaryViolation {
  path: string;
  reason: "frozen" | "outside-mutable";
}

export interface ForbiddenReference {
  path: string;
  needle: string;
}

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const OUTPUT_TAIL_CHARS = 64 * 1024;
const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;
const TARGET_ID = /^[a-z0-9][a-z0-9-]*$/;

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** `entry` ending in `/` is a directory prefix; anything else must match exactly. */
export function pathMatches(path: string, entry: string): boolean {
  const p = normalizePath(path);
  const e = normalizePath(entry);
  return e.endsWith("/") ? p.startsWith(e) : p === e;
}

export function findBoundaryViolations(
  changed: readonly string[],
  mutable: readonly string[],
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const raw of changed) {
    const path = normalizePath(raw);
    if (ALWAYS_FROZEN.some((entry) => pathMatches(path, entry))) {
      violations.push({ path, reason: "frozen" });
    } else if (!mutable.some((entry) => pathMatches(path, entry))) {
      violations.push({ path, reason: "outside-mutable" });
    }
  }
  return violations;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** (max - min) relative to the median, in percent. Used as the per-run noise estimate. */
export function spreadPct(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mid = median(values);
  const range = Math.max(...values) - Math.min(...values);
  if (range === 0) return 0;
  return mid === 0 ? 100 : (range / Math.abs(mid)) * 100;
}

/** Positive means better, whichever direction the metric improves in. */
export function changePct(
  baseline: number,
  current: number,
  direction: Direction,
): number {
  if (!(baseline > 0)) throw new Error("baseline metric must be positive");
  return direction === "lower"
    ? ((baseline - current) / baseline) * 100
    : ((current - baseline) / baseline) * 100;
}

export interface VerdictInput {
  baselineMedian: number;
  baselineSpreadPct: number;
  currentMedian: number;
  currentSpreadPct: number;
  direction: Direction;
  minImprovementPct: number;
}

export function decideVerdict(input: VerdictInput): {
  verdict: Exclude<Verdict, "guard-failed">;
  changePct: number;
  thresholdPct: number;
} {
  const change = changePct(
    input.baselineMedian,
    input.currentMedian,
    input.direction,
  );
  // A change must beat the larger of the configured minimum and the observed run-to-run noise.
  const threshold = Math.max(
    input.minImprovementPct,
    input.baselineSpreadPct,
    input.currentSpreadPct,
  );
  const verdict =
    change >= threshold
      ? "improved"
      : change <= -threshold
        ? "regressed"
        : "no-change";
  return { verdict, changePct: change, thresholdPct: threshold };
}

/** A measurement command prints one JSON object on its last non-empty stdout line. */
export function parseMeasurement(stdout: string): Measurement {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) throw new Error("measurement printed nothing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    throw new Error("measurement's last stdout line is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("measurement JSON must be an object");
  }
  const { value, details } = parsed as { value?: unknown; details?: unknown };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("measurement JSON needs a finite numeric `value`");
  }
  return {
    value,
    details:
      typeof details === "object" && details !== null
        ? (details as Record<string, unknown>)
        : {},
  };
}

export function parseTargetConfig(raw: unknown, expectedId?: string): TargetConfig {
  const fail = (message: string): never => {
    throw new Error(`invalid target config: ${message}`);
  };
  if (typeof raw !== "object" || raw === null) return fail("not an object");
  const c = raw as Record<string, unknown>;
  const strings = (key: string): string[] => {
    const v = c[key];
    if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
      return fail(`${key} must be an array of strings`);
    }
    return v as string[];
  };
  if (c.schema !== 1) fail("schema must be 1");
  if (typeof c.id !== "string" || !TARGET_ID.test(c.id)) fail("id must match [a-z0-9-]+");
  if (expectedId !== undefined && c.id !== expectedId) fail(`id ${String(c.id)} does not match file ${expectedId}`);
  if (c.status !== "ready" && c.status !== "analysis-only" && c.status !== "blocked") {
    fail("status must be ready, analysis-only, or blocked");
  }
  if (typeof c.description !== "string" || c.description.length === 0) fail("description is required");
  const metric = c.metric as Record<string, unknown> | undefined;
  if (
    !metric ||
    typeof metric.name !== "string" ||
    typeof metric.unit !== "string" ||
    (metric.direction !== "lower" && metric.direction !== "higher")
  ) {
    fail("metric needs name, unit, and direction (lower|higher)");
  }
  const measure = strings("measure");
  if (measure.length === 0) fail("measure must not be empty");
  if (!Number.isInteger(c.runs) || (c.runs as number) < 1 || (c.runs as number) > 25) fail("runs must be an integer 1..25");
  if (typeof c.minImprovementPct !== "number" || !(c.minImprovementPct > 0)) fail("minImprovementPct must be > 0");
  if (!Number.isInteger(c.timeoutMs) || (c.timeoutMs as number) < 1000) fail("timeoutMs must be an integer >= 1000");
  const mutable = strings("mutable");
  for (const entry of mutable) {
    if (ALWAYS_FROZEN.some((frozen) => pathMatches(entry, frozen) || pathMatches(frozen, entry))) {
      fail(`mutable path ${entry} overlaps the always-frozen set`);
    }
  }
  const guards = c.guards;
  if (!Array.isArray(guards) || guards.some((g) => !Array.isArray(g) || g.length === 0 || g.some((s) => typeof s !== "string"))) {
    fail("guards must be an array of non-empty argv arrays");
  }
  return {
    schema: 1,
    id: c.id as string,
    status: c.status as TargetStatus,
    description: c.description as string,
    metric: metric as TargetConfig["metric"],
    measure,
    runs: c.runs as number,
    minImprovementPct: c.minImprovementPct as number,
    timeoutMs: c.timeoutMs as number,
    mutable,
    fixtures: strings("fixtures"),
    forbiddenInMutable: strings("forbiddenInMutable"),
    guards: guards as string[][],
    notes: typeof c.notes === "string" ? c.notes : undefined,
  };
}

export function loadTarget(root: string, id: string): TargetConfig {
  if (!TARGET_ID.test(id)) throw new Error(`invalid target id: ${id}`);
  const file = join(root, "scripts", "research", "targets", `${id}.json`);
  if (!existsSync(file)) throw new Error(`unknown target: ${id}`);
  return parseTargetConfig(JSON.parse(readFileSync(file, "utf8")), id);
}

export function stateDir(root: string, id: string): string {
  return join(root, ".tmp", "research", id);
}

/** Write via a temp file in the same directory so a crash never leaves partial JSON behind. */
export function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function hashFiles(root: string, relPaths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const rel of [...relPaths].map(normalizePath).sort()) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      throw new Error(`fixture missing: ${rel} (see scripts/research/README.md)`);
    }
    const fileHash = createHash("sha256").update(readFileSync(abs)).digest("hex");
    hash.update(`${rel}\0${fileHash}\n`);
  }
  return hash.digest("hex");
}

export function findForbiddenReferences(
  root: string,
  paths: readonly string[],
  needles: readonly string[],
): ForbiddenReference[] {
  const found: ForbiddenReference[] = [];
  if (needles.length === 0) return found;
  for (const rel of paths.map(normalizePath)) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const stats = statSync(abs);
    if (!stats.isFile() || stats.size > MAX_SCANNED_FILE_BYTES) continue;
    const text = readFileSync(abs, "utf8");
    for (const needle of needles) {
      if (text.includes(needle)) found.push({ path: rel, needle });
    }
  }
  return found;
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text;
}

/** Run argv without a shell. `bun` is replaced by the current Bun binary; output keeps only the tail. */
export async function runCommand(
  argv: readonly string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string | undefined> },
): Promise<CommandResult> {
  const command = argv[0] === "bun" ? [process.execPath, ...argv.slice(1)] : [...argv];
  const started = performance.now();
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const exitCode = await child.exited;
    return {
      exitCode,
      stdout: tail(stdout),
      stderr: tail(stderr),
      timedOut,
      durationMs: performance.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function gitHeadSha(root: string): Promise<string> {
  const result = await runCommand(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 15_000 });
  if (result.exitCode !== 0) throw new Error("git rev-parse HEAD failed");
  return result.stdout.trim();
}

/** Files changed since `sinceSha`: committed or not, plus untracked files that are not ignored. */
export async function gitChangedPaths(root: string, sinceSha: string): Promise<string[]> {
  const diff = await runCommand(["git", "diff", "--name-only", sinceSha], { cwd: root, timeoutMs: 30_000 });
  const untracked = await runCommand(["git", "ls-files", "--others", "--exclude-standard"], { cwd: root, timeoutMs: 30_000 });
  if (diff.exitCode !== 0 || untracked.exitCode !== 0) throw new Error("git could not list changed files");
  const all = `${diff.stdout}\n${untracked.stdout}`
    .split("\n")
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean);
  return [...new Set(all)].sort();
}

export interface ShardFile {
  path: string;
  bytes: number;
}

/** Returns an error message when `shards` is not an exact partition of `input`, else null. */
export function validatePartition(
  input: readonly ShardFile[],
  shards: readonly (readonly ShardFile[])[],
  shardCount: number,
): string | null {
  if (!Array.isArray(shards) || shards.length !== shardCount) {
    return `expected ${shardCount} shards, got ${Array.isArray(shards) ? shards.length : "none"}`;
  }
  const seen = new Map<string, number>();
  for (const shard of shards) {
    if (!Array.isArray(shard)) return "a shard is not an array";
    for (const file of shard) seen.set(file.path, (seen.get(file.path) ?? 0) + 1);
  }
  const expected = new Set(input.map((file) => file.path));
  for (const [path, count] of seen) {
    if (!expected.has(path)) return `unknown file in shards: ${path}`;
    if (count > 1) return `file assigned ${count} times: ${path}`;
  }
  for (const path of expected) if (!seen.has(path)) return `file missing from shards: ${path}`;
  return null;
}

export function shardTotals(
  shards: readonly (readonly ShardFile[])[],
  seconds: Readonly<Record<string, number>>,
): number[] {
  return shards.map((shard) =>
    shard.reduce((sum, file) => {
      const value = seconds[file.path];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`no valid timing for ${file.path}; refresh the timings fixture`);
      }
      return sum + value;
    }, 0),
  );
}

/** max / mean of the shard totals; 1 means perfectly balanced. */
export function imbalance(totals: readonly number[]): number {
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  return mean === 0 ? 1 : Math.max(...totals) / mean;
}
