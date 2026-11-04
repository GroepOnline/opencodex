import "../../src/lib/trusted-launch-env-bootstrap";
import {
  isTrustedLaunchEnv,
  trustedLaunchEnvValue,
} from "../../src/lib/trusted-launch-env.mjs";

process.stdout.write(JSON.stringify({
  adminTokenPresent: Boolean(process.env.OPENCODEX_ADMIN_AUTH_TOKEN),
  apiTokenPresent: Boolean(process.env.OPENCODEX_API_AUTH_TOKEN),
  opencodexHome: process.env.OPENCODEX_HOME ?? null,
  codexCliPath: process.env.CODEX_CLI_PATH ?? null,
  bunPath: process.env.OPENCODEX_BUN_PATH ?? null,
  tokenFile: process.env.OCX_API_TOKEN_FILE ?? null,
  npmRegistry: process.env.npm_config_registry ?? null,
  path: process.env.PATH ?? null,
  home: process.env.HOME ?? null,
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
  providerSetting: process.env.PROJECT_PROVIDER_SETTING ?? null,
  baseUrlTrusted: isTrustedLaunchEnv("ANTHROPIC_BASE_URL"),
  adminTokenTrusted: trustedLaunchEnvValue("OPENCODEX_ADMIN_AUTH_TOKEN") !== undefined,
  trustedMarker: process.env.OCX_PRE_BUN_TRUSTED_ENV ?? null,
}) + "\n");
