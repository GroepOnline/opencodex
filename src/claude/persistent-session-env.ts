import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { claudeConfigDir } from "./gateway-cache";
import { recordOwnedConfigPath } from "../lib/config-ownership";

export interface PersistentClaudeEnv {
  [key: string]: string | undefined;
}

interface PreviousValue {
  present: boolean;
  value?: unknown;
}

interface PersistentEnvState {
  version: 1;
  settingsPath: string;
  previous: Record<string, PreviousValue>;
}

export interface PersistentEnvSyncResult {
  synced: boolean;
  settingsPath: string;
  statePath: string;
  warning?: string;
}

const MANAGED_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "DISABLE_COMPACT",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
] as const;

type ManagedKey = typeof MANAGED_KEYS[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Claude settings root must be a JSON object");
  return parsed;
}

function readState(path: string, settingsPath: string): PersistentEnvState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)
      || parsed.version !== 1
      || parsed.settingsPath !== settingsPath
      || !isRecord(parsed.previous)) {
      throw new Error("invalid state");
    }
    const previous: Record<string, PreviousValue> = {};
    for (const [key, raw] of Object.entries(parsed.previous)) {
      if (!MANAGED_KEYS.includes(key as ManagedKey) || !isRecord(raw) || typeof raw.present !== "boolean") continue;
      previous[key] = raw.present ? { present: true, value: raw.value } : { present: false };
    }
    return { version: 1, settingsPath, previous };
  } catch {
    return { version: 1, settingsPath, previous: {} };
  }
}

/**
 * Environment that must survive Claude Code's terminal boundary.
 *
 * Agent View sessions are separate Claude Code processes parented to the per-user
 * supervisor. They do not reliably inherit the interactive terminal environment, but
 * Claude officially applies settings.json `env` to every session. Host-managed mode is
 * forced OFF here because it deliberately strips provider variables loaded from settings;
 * OCX owns and refreshes these exact keys instead.
 */
export function persistentClaudeEnv(source: PersistentClaudeEnv): Record<string, string> {
  const result: Record<string, string> = {
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0",
  };
  for (const key of MANAGED_KEYS) {
    if (key === "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST") continue;
    const value = source[key];
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  return result;
}

/**
 * Merge OCX-owned provider env into the user's Claude settings without replacing any
 * unrelated setting. Original values are journaled under OPENCODEX_HOME so switching
 * auth modes can restore keys that OCX no longer needs and stop/eject can restore all
 * managed keys later. Both files are written atomically with mode 0600.
 */
export function syncClaudePersistentSessionEnv(
  source: PersistentClaudeEnv,
  stateDir: string,
  configDir = claudeConfigDir(),
): PersistentEnvSyncResult {
  const settingsPath = join(configDir, "settings.json");
  const statePath = join(stateDir, "claude-persistent-env.json");
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    const settings = readSettings(settingsPath);
    const existingEnv = settings.env;
    if (existingEnv !== undefined && !isRecord(existingEnv)) {
      throw new Error("Claude settings `env` must be a JSON object");
    }
    const env: Record<string, unknown> = { ...(existingEnv as Record<string, unknown> | undefined) };
    const desired = persistentClaudeEnv(source);
    const state = readState(statePath, settingsPath);

    for (const key of MANAGED_KEYS) {
      const desiredValue = desired[key];
      if (desiredValue !== undefined) {
        if (!Object.prototype.hasOwnProperty.call(state.previous, key)) {
          state.previous[key] = Object.prototype.hasOwnProperty.call(env, key)
            ? { present: true, value: env[key] }
            : { present: false };
        }
        env[key] = desiredValue;
        continue;
      }

      const previous = state.previous[key];
      if (!previous) continue;
      if (previous.present) env[key] = previous.value;
      else delete env[key];
      delete state.previous[key];
    }

    settings.env = env;
    atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

    recordOwnedConfigPath(stateDir, statePath);
    atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
    return { synced: true, settingsPath, statePath };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      synced: false,
      settingsPath,
      statePath,
      warning: `Claude supervisor environment could not be persisted: ${detail}`,
    };
  }
}
