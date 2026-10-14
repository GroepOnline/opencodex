/**
 * Classify how a provider authenticates and whether config.json still holds leftover
 * plaintext apiKeys. Env-backed (`$VAR` / `${VAR}` via process.env, typically a
 * systemd EnvironmentFile=service.env), oauth-with-account, forward, or chefvault://
 * are the production happy path. Inline plaintext in config.json is a defect in
 * service mode and a warning for local `ocx start` — never a refuse.
 *
 * Never include secret values in messages or DTO fields.
 */
import type { OcxConfig, OcxProviderConfig } from "../types";

export type ProviderCredentialSource = "inline" | "env" | "oauth" | "forward" | "vault";

export type ProviderCredentialView = Pick<
  OcxProviderConfig,
  "authMode" | "credentialRef" | "apiKey" | "apiKeyPool"
>;

function isEnvValueRef(value: string | undefined): boolean {
  if (!value) return false;
  return /^\$\{\w+\}$/.test(value) || value.startsWith("$");
}

function configuredKeyMaterial(provider: ProviderCredentialView): string[] {
  const keys: string[] = [];
  if (typeof provider.apiKey === "string") keys.push(provider.apiKey);
  for (const entry of provider.apiKeyPool ?? []) {
    if (typeof entry.key === "string") keys.push(entry.key);
  }
  return keys;
}

/** Non-empty configured key that is not an `$ENV` / `${ENV}` reference. */
export function isInlinePlaintextApiKey(value: string | undefined): boolean {
  if (!value) return false;
  return !isEnvValueRef(value);
}

export function classifyProviderCredentialSource(
  provider: ProviderCredentialView,
): ProviderCredentialSource | undefined {
  if (provider.authMode === "oauth") return "oauth";
  if (provider.authMode === "forward") return "forward";
  if (provider.credentialRef?.trim()) return "vault";
  if (isEnvValueRef(provider.apiKey)) return "env";
  if (isInlinePlaintextApiKey(provider.apiKey)) return "inline";
  const pool = provider.apiKeyPool ?? [];
  if (pool.some((entry) => isEnvValueRef(entry.key))) return "env";
  if (pool.some((entry) => isInlinePlaintextApiKey(entry.key))) return "inline";
  return undefined;
}

export function providerHasInlinePlaintextSecret(provider: ProviderCredentialView): boolean {
  return configuredKeyMaterial(provider).some(isInlinePlaintextApiKey);
}

export function listInlinePlaintextProviders(config: Pick<OcxConfig, "providers">): string[] {
  return Object.entries(config.providers)
    .filter(([, provider]) => providerHasInlinePlaintextSecret(provider))
    .map(([name]) => name)
    .sort();
}

export function isServiceMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OCX_SERVICE?.trim();
  return raw === "1" || raw === "true";
}

export function formatInlineProviderSecretWarning(names: string[], serviceMode: boolean): string {
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

export function warnInlineProviderSecrets(
  config: Pick<OcxConfig, "providers">,
  io: { warn?: (message: string) => void; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const names = listInlinePlaintextProviders(config);
  if (names.length === 0) return names;
  const warn = io.warn ?? ((message: string) => console.warn(message));
  warn(formatInlineProviderSecretWarning(names, isServiceMode(io.env ?? process.env)));
  return names;
}

export function collectInlineSecretDoctorChecks(
  config: Pick<OcxConfig, "providers">,
): Array<{ level: "OK" | "WARN"; message: string }> {
  const names = listInlinePlaintextProviders(config);
  if (names.length === 0) {
    return [{
      level: "OK",
      message: "No plaintext provider apiKey values in config.json; keys are env refs, oauth, forward, or vault.",
    }];
  }
  return [{
    level: "WARN",
    message:
      `Provider(s) ${names.join(", ")} have a plaintext apiKey in config.json. ` +
      "Action: move each secret into the unit EnvironmentFile and set apiKey to $VAR or ${VAR}.",
  }];
}
