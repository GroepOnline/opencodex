import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendTrustedLaunchEnvMarker,
  captureTrustedLaunchEnvMarker,
  initializeTrustedLaunchEnv,
  isTrustedLaunchEnv,
  parseTrustedLaunchEnvMarker,
  trustedLaunchEnvValue,
  TRUSTED_LAUNCH_ENV_MARKER,
} from "../src/lib/trusted-launch-env.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("trusted launch environment provenance", () => {
  test("fails closed for privileged dotenv keys while preserving provider configuration", () => {
    const env = {
      [TRUSTED_LAUNCH_ENV_MARKER]: "PATH,HOME",
      PATH: "/usr/bin",
      HOME: "/home/joep",
      OPENCODEX_ADMIN_AUTH_TOKEN: "project-admin-token",
      OPENCODEX_API_AUTH_TOKEN: "project-api-token",
      OPENCODEX_HOME: "/tmp/project-home",
      CODEX_CLI_PATH: "/tmp/project-codex",
      OPENCODEX_BUN_PATH: "/tmp/project-bun",
      OCX_API_TOKEN_FILE: "/tmp/project-token",
      npm_config_registry: "https://registry.invalid",
      BUN_CONFIG_VERBOSE_FETCH: "1",
      ANTHROPIC_BASE_URL: "https://provider.invalid",
      PROJECT_PROVIDER_SETTING: "preserved",
    } as NodeJS.ProcessEnv;

    initializeTrustedLaunchEnv(env);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/joep");
    expect(env.OPENCODEX_ADMIN_AUTH_TOKEN).toBeUndefined();
    expect(env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
    expect(env.OPENCODEX_HOME).toBeUndefined();
    expect(env.CODEX_CLI_PATH).toBeUndefined();
    expect(env.OPENCODEX_BUN_PATH).toBeUndefined();
    expect(env.OCX_API_TOKEN_FILE).toBeUndefined();
    expect(env.npm_config_registry).toBeUndefined();
    expect(env.BUN_CONFIG_VERBOSE_FETCH).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("https://provider.invalid");
    expect(env.PROJECT_PROVIDER_SETTING).toBe("preserved");
    expect(trustedLaunchEnvValue("OPENCODEX_ADMIN_AUTH_TOKEN", env)).toBeUndefined();
    expect(trustedLaunchEnvValue("PATH", env)).toBe("/usr/bin");
  });

  test("preserves the original marker across nested launches instead of trusting dotenv additions", () => {
    const env = {
      [TRUSTED_LAUNCH_ENV_MARKER]: "PATH,HOME",
      PATH: "/usr/bin",
      HOME: "/home/joep",
      OPENCODEX_HOME: "/tmp/from-project-dotenv",
      PROJECT_SETTING: "project-value",
    } as NodeJS.ProcessEnv;

    expect(captureTrustedLaunchEnvMarker(env)).toBe("HOME,PATH");
    initializeTrustedLaunchEnv(env);
    expect(env.OPENCODEX_HOME).toBeUndefined();
    expect(env.PROJECT_SETTING).toBe("project-value");
  });

  test("allows trusted internal launchers to extend provenance for values they set", () => {
    const env = {
      [TRUSTED_LAUNCH_ENV_MARKER]: "PATH",
      OPENCODEX_CLAUDE_REAL_COMMAND: "/usr/local/bin/claude",
    } as NodeJS.ProcessEnv;

    expect(appendTrustedLaunchEnvMarker(env, "OPENCODEX_CLAUDE_REAL_COMMAND")).toBe(true);
    expect(isTrustedLaunchEnv("OPENCODEX_CLAUDE_REAL_COMMAND", env)).toBe(true);
    expect(trustedLaunchEnvValue("OPENCODEX_CLAUDE_REAL_COMMAND", env)).toBe("/usr/local/bin/claude");
  });

  test("captures the environment once and ignores project dotenv additions after Bun loads them", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-trusted-env-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, ".env"), [
      "OCX_PRE_BUN_TRUSTED_ENV=OPENCODEX_ADMIN_AUTH_TOKEN",
      "OPENCODEX_ADMIN_AUTH_TOKEN=project-admin-token",
      "OPENCODEX_API_AUTH_TOKEN=project-api-token",
      "OPENCODEX_HOME=/tmp/project-home",
      "CODEX_CLI_PATH=/tmp/project-codex",
      "OPENCODEX_BUN_PATH=/tmp/project-bun",
      "OCX_API_TOKEN_FILE=/tmp/project-token",
      "npm_config_registry=https://registry.invalid",
      "ANTHROPIC_BASE_URL=https://provider.invalid",
      "PROJECT_PROVIDER_SETTING=preserved",
    ].join("\n"));

    const env = { ...process.env, [TRUSTED_LAUNCH_ENV_MARKER]: "PATH,HOME" };
    for (const key of [
      "OPENCODEX_ADMIN_AUTH_TOKEN",
      "OPENCODEX_API_AUTH_TOKEN",
      "OPENCODEX_HOME",
      "CODEX_CLI_PATH",
      "OPENCODEX_BUN_PATH",
      "OCX_API_TOKEN_FILE",
      "npm_config_registry",
      "ANTHROPIC_BASE_URL",
      "PROJECT_PROVIDER_SETTING",
    ]) delete env[key];

    const probe = join(import.meta.dir, "fixtures", "trusted-launch-env-probe.ts");
    const result = spawnSync(process.execPath, [probe], { cwd: dir, env, encoding: "utf8" });
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout.trim());
    expect(observed.adminToken).toBeNull();
    expect(observed.apiToken).toBeNull();
    expect(observed.opencodexHome).toBeNull();
    expect(observed.codexCliPath).toBeNull();
    expect(observed.bunPath).toBeNull();
    expect(observed.tokenFile).toBeNull();
    expect(observed.npmRegistry).toBeNull();
    expect(observed.baseUrl).toBe("https://provider.invalid");
    expect(observed.providerSetting).toBe("preserved");
    expect(observed.baseUrlTrusted).toBe(false);
    expect(observed.adminTokenTrusted).toBe(false);
    expect(observed.trustedMarker).toBe("PATH,HOME");
  });

  test("parses malformed and empty markers fail-closed", () => {
    expect([...parseTrustedLaunchEnvMarker("")!]).toEqual([]);
    expect([...parseTrustedLaunchEnvMarker("PATH,not a name,HOME")!]).toEqual(["PATH", "HOME"]);
    const env = { [TRUSTED_LAUNCH_ENV_MARKER]: "", OPENCODEX_HOME: "/tmp/unsafe" } as NodeJS.ProcessEnv;
    initializeTrustedLaunchEnv(env);
    expect(env.OPENCODEX_HOME).toBeUndefined();
  });
});
