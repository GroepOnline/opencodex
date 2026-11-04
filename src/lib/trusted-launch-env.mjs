export const TRUSTED_LAUNCH_ENV_MARKER = "OCX_PRE_BUN_TRUSTED_ENV";

const LEGACY_ANTHROPIC_MARKER = "OCX_PRE_BUN_ANTHROPIC_ENV";
const PROTECTED_ENV_NAMES = new Set([
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_USER_DATA_DIR",
  "CODEX_CLI_PATH",
  "CODEX_HOME",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NODE_OPTIONS",
  "NODE_PATH",
  "OPENCODEX_ADMIN_AUTH_TOKEN",
  "OPENCODEX_API_AUTH_TOKEN",
  "OPENCODEX_BIND_HOST",
  "OPENCODEX_BUN_PATH",
  "OPENCODEX_CLAUDE_REAL_COMMAND",
  "OPENCODEX_HOME",
  "PATHEXT",
  "PATH",
  "SHELL",
  "SYSTEMROOT",
  "USERPROFILE",
  "WINDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "OCX_API_TOKEN_FILE",
].map((name) => name.toUpperCase()));

function normalizeName(name) {
  return String(name).trim().toUpperCase();
}

export function parseTrustedLaunchEnvMarker(value) {
  if (typeof value !== "string") return null;
  const names = new Set();
  for (const rawName of value.split(",")) {
    const name = normalizeName(rawName);
    if (/^[A-Z_][A-Z0-9_]*$/.test(name)) names.add(name);
  }
  return names;
}

export function captureTrustedLaunchEnvMarker(env = process.env) {
  const inherited = env[TRUSTED_LAUNCH_ENV_MARKER];
  if (typeof inherited === "string") {
    const names = parseTrustedLaunchEnvMarker(inherited) ?? new Set();
    return [...names].sort().join(",");
  }

  return Object.keys(env)
    .filter((name) => name !== TRUSTED_LAUNCH_ENV_MARKER && name !== LEGACY_ANTHROPIC_MARKER)
    .filter((name) => typeof env[name] === "string" && env[name] !== "")
    .map(normalizeName)
    .filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name))
    .sort()
    .join(",");
}

export function appendTrustedLaunchEnvMarker(env, name) {
  const inherited = env?.[TRUSTED_LAUNCH_ENV_MARKER];
  if (typeof inherited !== "string") return false;
  const names = parseTrustedLaunchEnvMarker(inherited) ?? new Set();
  names.add(normalizeName(name));
  env[TRUSTED_LAUNCH_ENV_MARKER] = [...names].sort().join(",");
  return true;
}

export function isProtectedLaunchEnvName(name) {
  const normalized = normalizeName(name);
  return PROTECTED_ENV_NAMES.has(normalized)
    || normalized.startsWith("NPM_CONFIG_")
    || normalized.startsWith("BUN_CONFIG_");
}

export function initializeTrustedLaunchEnv(env = process.env) {
  const names = parseTrustedLaunchEnvMarker(env?.[TRUSTED_LAUNCH_ENV_MARKER]);
  if (names === null) return null;

  for (const name of Object.keys(env)) {
    if (isProtectedLaunchEnvName(name) && !names.has(normalizeName(name))) {
      delete env[name];
    }
  }
  return names;
}

export function isTrustedLaunchEnv(name, env = process.env) {
  const names = parseTrustedLaunchEnvMarker(env?.[TRUSTED_LAUNCH_ENV_MARKER]);
  return names === null || names.has(normalizeName(name));
}

export function trustedLaunchEnvValue(name, env = process.env) {
  return isTrustedLaunchEnv(name, env) ? env?.[name] : undefined;
}
