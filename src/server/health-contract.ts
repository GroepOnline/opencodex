import { existsSync, statSync } from "node:fs";
import { getConfigPath } from "../config";
import { usageLogPath } from "../usage/log";
import type { OcxConfig } from "../types";

export type HealthComponentStatus = "ok" | "degraded" | "down" | "unknown";

export interface HealthComponent {
  status: HealthComponentStatus;
  since: string | null;
  message: string;
  depends_on?: string[];
}

export interface ProviderHealthComponent extends HealthComponent {
  name: string;
  disabled: boolean;
}

export interface HealthCausalityEntry {
  component: string;
  status: HealthComponentStatus;
  since: string | null;
  reason: string;
  depends_on: string[];
}

export interface HealthContract {
  status: HealthComponentStatus;
  checked_at: string;
  contract_version: string;
  components: {
    proxy: HealthComponent;
    management_api: HealthComponent;
    persistence: HealthComponent;
    providers: ProviderHealthComponent[];
    deploy_runner: HealthComponent;
  };
  causality: HealthCausalityEntry[];
}

function aggregateStatus(statuses: HealthComponentStatus[]): HealthComponentStatus {
  if (statuses.some(s => s === "down")) return "down";
  if (statuses.some(s => s === "degraded")) return "degraded";
  if (statuses.every(s => s === "unknown")) return "unknown";
  return "ok";
}

function persistenceHealth(): HealthComponent {
  const configPath = getConfigPath();
  const usagePath = usageLogPath();
  const missing: string[] = [];
  if (!existsSync(configPath)) missing.push("config");
  if (!existsSync(usagePath)) missing.push("usage_log");
  if (missing.length === 2) {
    return {
      status: "down",
      since: null,
      message: "config.json and usage.jsonl are both missing",
    };
  }
  if (missing.length === 1) {
    return {
      status: "degraded",
      since: null,
      message: `${missing[0]} missing — first-run or partial state`,
    };
  }
  try {
    statSync(configPath);
    statSync(usagePath);
    return {
      status: "ok",
      since: null,
      message: "config.json and usage.jsonl are readable",
    };
  } catch (err) {
    return {
      status: "degraded",
      since: null,
      message: err instanceof Error ? err.message : "persistence read failed",
    };
  }
}

function providerHealth(config: OcxConfig): ProviderHealthComponent[] {
  return Object.entries(config.providers ?? {}).map(([name, provider]) => {
    const disabled = provider.disabled === true;
    const hasCredential = Boolean(provider.apiKey) || provider.authMode === "forward" || provider.authMode === "oauth";
    let status: HealthComponentStatus = "ok";
    let message = "configured";
    if (disabled) {
      status = "degraded";
      message = "provider disabled";
    } else if (provider.authMode !== "forward" && provider.liveModels !== false && !hasCredential) {
      status = "degraded";
      message = "missing credentials or API key";
    }
    return {
      name,
      disabled,
      status,
      since: null,
      message,
      depends_on: ["persistence"],
    };
  });
}

function buildCausality(components: HealthContract["components"]): HealthCausalityEntry[] {
  const entries: HealthCausalityEntry[] = [];
  const push = (component: string, item: HealthComponent, dependsOn: string[] = []) => {
    if (item.status === "ok") return;
    entries.push({
      component,
      status: item.status,
      since: item.since,
      reason: item.message,
      depends_on: dependsOn,
    });
  };
  push("proxy", components.proxy);
  push("management_api", components.management_api);
  push("persistence", components.persistence);
  for (const provider of components.providers) {
    if (provider.status !== "ok") {
      entries.push({
        component: `provider:${provider.name}`,
        status: provider.status,
        since: provider.since,
        reason: provider.message,
        depends_on: provider.depends_on ?? ["persistence"],
      });
    }
  }
  push("deploy_runner", components.deploy_runner);
  return entries;
}

export function buildHealthContract(
  config: OcxConfig,
  opts: { managementAuthAvailable: boolean; contractVersion: string },
): HealthContract {
  const checkedAt = new Date().toISOString();
  const management: HealthComponent = opts.managementAuthAvailable
    ? { status: "ok", since: null, message: "management credential available" }
    : {
      status: "down",
      since: null,
      message: "management credential unavailable — /api/* returns 503",
      depends_on: ["persistence"],
    };
  const persistence = persistenceHealth();
  const providers = providerHealth(config);
  const deployRunner: HealthComponent = {
    status: "unknown",
    since: null,
    message: "deploy runner liveness is out-of-process — probe ocx-deploy runner or workflow host",
  };
  const proxy: HealthComponent = {
    status: "ok",
    since: null,
    message: "proxy process is serving requests",
  };
  const components = {
    proxy,
    management_api: management,
    persistence,
    providers,
    deploy_runner: deployRunner,
  };
  const statuses: HealthComponentStatus[] = [
    proxy.status,
    management.status,
    persistence.status,
    ...providers.map(p => p.status),
  ];
  return {
    status: aggregateStatus(statuses),
    checked_at: checkedAt,
    contract_version: opts.contractVersion,
    components,
    causality: buildCausality(components),
  };
}
