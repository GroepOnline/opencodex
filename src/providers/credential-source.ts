/**
 * Classify how a provider authenticates and whether config.json still holds leftover
 * plaintext apiKeys. Env-backed (`$VAR` / `${VAR}` via process.env, typically a
 * systemd EnvironmentFile=service.env), oauth-with-account, forward, or chefvault://
 * are the production happy path. Inline plaintext in config.json is a defect in
 * service mode and a warning for local `ocx start` — never a refuse.
 *
 * Never include secret values in messages or DTO fields.
 */
import { isEnvValueRef } from "../config";
import type { OcxConfig, OcxProviderConfig } from "../types";

export type ProviderCredentialSource =
  "inline" | "env" | "oauth" | "forward" | "vault";

export type ProviderCredentialView = Pick<
  OcxProviderConfig,
  "authMode" | "credentialRef" | "apiKey" | "apiKeyPool"
>;

/** Collect string keys while tolerating malformed values from passthrough config fields. */
function configuredPoolKeyMaterial(provider: ProviderCredentialView): string[] {
  if (!Array.isArray(provider.apiKeyPool)) return [];
  const keys: string[] = [];
  for (const entry of provider.apiKeyPool) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.key === "string") keys.push(entry.key);
  }
  return keys;
}

/** Collect configured string keys from apiKey and apiKeyPool, including empty values. */
function configuredKeyMaterial(provider: ProviderCredentialView): string[] {
  const keys: string[] = [];
  if (typeof provider.apiKey === "string") keys.push(provider.apiKey);
  return [...keys, ...configuredPoolKeyMaterial(provider)];
}

/** Identify a non-empty configured key that does not start with `$`; whitespace is not trimmed. */
export function isInlinePlaintextApiKey(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  return !isEnvValueRef(value);
}

/**
 * Classify configured credentials without resolving or validating them. OAuth and forward
 * auth modes take precedence, then any nonblank credentialRef (vault), then apiKey,
 * then apiKeyPool. Within the pool, an environment reference takes precedence over
 * an inline key. Return undefined when none of these sources is configured.
 */
export function classifyProviderCredentialSource(
  provider: ProviderCredentialView,
): ProviderCredentialSource | undefined {
  if (provider.authMode === "oauth") return "oauth";
  if (provider.authMode === "forward") return "forward";
  if (
    typeof provider.credentialRef === "string" &&
    provider.credentialRef.trim()
  ) {
    return "vault";
  }
  if (typeof provider.apiKey === "string" && isEnvValueRef(provider.apiKey)) {
    return "env";
  }
  if (isInlinePlaintextApiKey(provider.apiKey)) return "inline";
  const pool = configuredPoolKeyMaterial(provider);
  if (pool.some(isEnvValueRef)) return "env";
  if (pool.some(isInlinePlaintextApiKey)) return "inline";
  return undefined;
}

/** Detect inline keys in apiKey or apiKeyPool regardless of authMode or credentialRef. */
export function providerHasInlinePlaintextSecret(
  provider: ProviderCredentialView,
): boolean {
  return configuredKeyMaterial(provider).some(isInlinePlaintextApiKey);
}

/** Return sorted provider names with inline keys, including disabled providers. */
export function listInlinePlaintextProviders(
  config: Pick<OcxConfig, "providers">,
): string[] {
  return Object.entries(config.providers)
    .filter(([, provider]) => providerHasInlinePlaintextSecret(provider))
    .map(([name]) => name)
    .sort();
}

/** Detect service mode only when trimmed OCX_SERVICE is exactly `1` or `true`. */
export function isServiceMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OCX_SERVICE?.trim();
  return raw === "1" || raw === "true";
}

/** Format a warning from provider names with service or local environment guidance. */
export function formatInlineProviderSecretWarning(
  names: string[],
  serviceMode: boolean,
): string {
  const listed = names.join(", ");
  if (serviceMode) {
    return (
      `Warning: provider(s) ${listed} store a plaintext apiKey in config.json. ` +
      "Move each value into the service env and set apiKey to $VAR or ${VAR}."
    );
  }
  return (
    `Warning: provider(s) ${listed} store a plaintext apiKey in config.json. ` +
    "Prefer $VAR / ${VAR} from the environment. Local ocx start still accepts inline keys."
  );
}

/**
 * Return sorted provider names with inline keys and emit one warning if any exist.
 * Defaults to console.warn and process.env; messages include names, not key values.
 * Errors thrown by io.warn propagate to the caller.
 */
export function warnInlineProviderSecrets(
  config: Pick<OcxConfig, "providers">,
  io: { warn?: (message: string) => void; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const names = listInlinePlaintextProviders(config);
  if (names.length === 0) return names;
  const warn = io.warn ?? ((message: string) => console.warn(message));
  warn(
    formatInlineProviderSecretWarning(
      names,
      isServiceMode(io.env ?? process.env),
    ),
  );
  return names;
}

/** Return one doctor check: WARN with affected provider names, or OK when no inline keys exist. */
export function collectInlineSecretDoctorChecks(
  config: Pick<OcxConfig, "providers">,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ level: "OK" | "WARN"; message: string }> {
  const names = listInlinePlaintextProviders(config);
  if (names.length === 0) {
    return [
      {
        level: "OK",
        message:
          "No plaintext provider apiKey values in config.json; keys are env refs, oauth, forward, or vault.",
      },
    ];
  }
  const service = isServiceMode(env);
  return [
    {
      level: "WARN",
      message:
        `Provider(s) ${names.join(", ")} have a plaintext apiKey in config.json. ` +
        (service
          ? "Action: move each secret into the unit EnvironmentFile and set apiKey to $VAR or ${VAR}."
          : "Action: set each secret as an environment variable and set apiKey to $VAR or ${VAR}. Local ocx start still accepts inline keys."),
    },
  ];
}
