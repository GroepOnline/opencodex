import { existsSync, readFileSync } from "node:fs";
import { MANAGEMENT_CONTRACT_VERSION } from "./contract-version";
import { VERSION } from "./management-api";

export interface BuildInfoFile {
  git_sha?: string | null;
  built_at?: string | null;
  release?: string | null;
  gui_version?: string | null;
}

export interface ProvenanceRuntime {
  service: "opencodex";
  pid: number;
  port: number;
  uptime: number;
  platform: NodeJS.Platform;
  bunVersion: string;
}

export interface PublicProvenance {
  contract_version: string;
  version: string;
  git_sha: string | null;
  built_at: string | null;
  release: string | null;
  schema_version: string | null;
  gui_version: string | null;
  runtime: ProvenanceRuntime;
}

export interface AuthenticatedProvenance extends PublicProvenance {
  management: {
    contract_version: string;
    hostname: string | null;
    default_provider: string | null;
    provider_count: number;
    management_auth_available: boolean;
  };
}

let cachedBuildInfo: BuildInfoFile | null | undefined;

function loadBuildInfo(): BuildInfoFile {
  if (cachedBuildInfo !== undefined) return cachedBuildInfo ?? {};
  try {
    const raw = readFileSync(new URL("../build-info.json", import.meta.url), "utf8");
    cachedBuildInfo = JSON.parse(raw) as BuildInfoFile;
  } catch {
    cachedBuildInfo = null;
  }
  return cachedBuildInfo ?? {};
}

export function resetBuildInfoCacheForTests(): void {
  cachedBuildInfo = undefined;
}

export function readSchemaVersion(config: Record<string, unknown>): string | null {
  const direct = config.schema_version ?? config.schemaVersion;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (typeof direct === "number" && Number.isFinite(direct)) return String(direct);
  return null;
}

export function buildPublicProvenance(
  config: Record<string, unknown>,
  listenPort: number,
): PublicProvenance {
  const build = loadBuildInfo();
  return {
    contract_version: MANAGEMENT_CONTRACT_VERSION,
    version: VERSION,
    git_sha: typeof build.git_sha === "string" && build.git_sha ? build.git_sha : null,
    built_at: typeof build.built_at === "string" && build.built_at ? build.built_at : null,
    release: typeof build.release === "string" && build.release ? build.release : null,
    schema_version: readSchemaVersion(config),
    gui_version: typeof build.gui_version === "string" && build.gui_version
      ? build.gui_version
      : VERSION,
    runtime: {
      service: "opencodex",
      pid: process.pid,
      port: listenPort,
      uptime: process.uptime(),
      platform: process.platform,
      bunVersion: Bun.version,
    },
  };
}

export function buildAuthenticatedProvenance(
  config: Record<string, unknown>,
  listenPort: number,
  managementAuthAvailable: boolean,
): AuthenticatedProvenance {
  const base = buildPublicProvenance(config, listenPort);
  const providers = config.providers;
  const providerCount = providers && typeof providers === "object" && !Array.isArray(providers)
    ? Object.keys(providers).length
    : 0;
  return {
    ...base,
    management: {
      contract_version: MANAGEMENT_CONTRACT_VERSION,
      hostname: typeof config.hostname === "string" ? config.hostname : null,
      default_provider: typeof config.defaultProvider === "string" ? config.defaultProvider : null,
      provider_count: providerCount,
      management_auth_available: managementAuthAvailable,
    },
  };
}

/** Test-only: inject build metadata without rewriting build-info.json on disk. */
export function setBuildInfoForTests(info: BuildInfoFile | null): void {
  cachedBuildInfo = info;
}
