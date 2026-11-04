export const TRUSTED_LAUNCH_ENV_MARKER: string;
export function parseTrustedLaunchEnvMarker(value: string | undefined): Set<string> | null;
export function captureTrustedLaunchEnvMarker(env?: NodeJS.ProcessEnv): string;
export function appendTrustedLaunchEnvMarker(env: NodeJS.ProcessEnv, name: string): boolean;
export function isProtectedLaunchEnvName(name: string): boolean;
export function initializeTrustedLaunchEnv(env?: NodeJS.ProcessEnv): Set<string> | null;
export function isTrustedLaunchEnv(name: string, env?: NodeJS.ProcessEnv): boolean;
export function trustedLaunchEnvValue(name: string, env?: NodeJS.ProcessEnv): string | undefined;
