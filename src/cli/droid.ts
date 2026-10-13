/**
 * `ocx droid [droid args...]` — launch Factory Droid wired to the local OCX proxy.
 *
 * OCX-only-first contract (opencodex issue #336): Droid must be able to run on
 * OCX-provided models and OCX credentials without a paid Factory model
 * subscription. Native Factory defaults and the user's existing `customModels`
 * array must be preserved untouched, so this launcher NEVER rewrites
 * `~/.factory/settings.json`. Instead it passes an isolated `--settings` overlay
 * at launch time through the existing Factory BYOK custom-model mechanism.
 *
 * The overlay is additive: it carries the OCX endpoint, the admission credential
 * resolution, and the OCX model rows. Factory merges `--settings` over the user's
 * file for this process only, so a later plain `droid` is byte-identical to
 * before. The admission token is never written into the overlay file on disk
 * when a keyless/env reference can carry it, mirroring the opencode launcher.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config";
import { commandInvocation } from "../lib/win-exec";
import { configuredAdminToken } from "../lib/admin-secrets";
import { findLiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";

/** One custom-model row in Factory's `customModels` schema (BYOK reference). */
export interface DroidCustomModel {
  id: string;
  index: number;
  model: string;
  displayName: string;
  baseUrl: string;
  provider: "openai" | "anthropic" | "generic-chat-completion-api";
  apiKey?: string;
  maxOutputTokens: number;
  noImageSupport: boolean;
}

/** The isolated Factory settings overlay handed to `droid --settings <file>`. */
export interface DroidSettingsOverlay {
  model: string;
  customModels: DroidCustomModel[];
}

export interface DroidRoutedModel {
  provider: string;
  id: string;
  displayName?: string;
  inputModalities?: string[];
}

/**
 * Preserve the full routed selector. The OCX proxy requires the provider prefix
 * to distinguish models that share an id across different providers.
 */
export function droidModelId(routed: string): string {
  return routed;
}

/** Stable Factory BYOK ID: independent of display names and catalog ordering. */
export function droidCustomModelId(routed: string): string {
  return `custom:ocx-${createHash("sha256").update(routed).digest("hex").slice(0, 24)}`;
}

/**
 * OCX serves the OpenAI Responses wire on `/v1`, which Factory reaches through
 * `provider: "openai"`. When the proxy is not a loopback origin the admission
 * credential travels as a bearer/env reference; the value itself is never
 * serialized here.
 */
export function droidBaseUrl(port: number, origin?: string): string {
  const root =
    origin && origin.length > 0
      ? origin.replace(/\/+$/, "")
      : `http://127.0.0.1:${port}`;
  return `${root}/v1`;
}

/**
 * Build the isolated overlay. `apiKeyRef` is an environment-variable reference
 * (`${OCX_ADMISSION_TOKEN}`) or a loopback placeholder: on a plain loopback proxy
 * the OCX gateway admits the request without a service credential, and embedding a
 * real secret in a temp file would be a credential-handling regression.
 */
export function buildDroidSettingsOverlay(
  config: OcxConfig,
  port: number,
  models: readonly DroidRoutedModel[],
  options: { origin?: string; apiKeyRef?: string } = {},
): DroidSettingsOverlay {
  const baseUrl = droidBaseUrl(port, options.origin);
  const apiKey = options.apiKeyRef;
  const uniqueModels = new Map<string, DroidRoutedModel>();
  for (const model of models) {
    if (
      typeof model.id === "string" &&
      model.id.length > 0 &&
      !uniqueModels.has(model.id)
    ) {
      uniqueModels.set(model.id, model);
    }
  }
  const rows: DroidCustomModel[] = [...uniqueModels.values()].map(
    (model, index) => ({
      id: droidCustomModelId(model.id),
      index,
      model: droidModelId(model.id),
      displayName:
        model.displayName && model.displayName.length > 0
          ? model.displayName
          : `OCX / ${droidModelId(model.id)}`,
      baseUrl,
      provider: "openai" as const,
      ...(apiKey ? { apiKey } : {}),
      maxOutputTokens: 128_000,
      noImageSupport: !model.inputModalities?.includes("image"),
    }),
  );
  const preferred = config.injectionModel
    ? rows.find((row) => row.model === droidModelId(config.injectionModel!))
    : undefined;
  return { model: (preferred ?? rows[0])?.id ?? "", customModels: rows };
}

/** Factory resolves env references at launch; the key stays in the child env.
 * Never substitute a management/admin token for a data-plane credential.
 * A non-loopback-bound OCX proxy may require auth even via 127.0.0.1.
 */
export function droidAdmissionEnvironment(
  config: OcxConfig,
  parentEnv: NodeJS.ProcessEnv = process.env,
): { env: NodeJS.ProcessEnv; apiKeyRef?: string } {
  const token =
    parentEnv.OCX_ADMISSION_TOKEN?.trim() ||
    parentEnv.OPENCODEX_API_AUTH_TOKEN?.trim() ||
    config.apiKeys
      ?.find((entry) => typeof entry.key === "string" && entry.key.trim())
      ?.key.trim();
  // Keep normal launch settings, but never expose the OCX management key
  // to the independent Factory CLI child process.
  const childEnv = { ...parentEnv };
  delete childEnv.OPENCODEX_ADMIN_AUTH_TOKEN;
  if (token) childEnv.OCX_ADMISSION_TOKEN = token;
  return {
    env: childEnv,
    ...(token ? { apiKeyRef: "${OCX_ADMISSION_TOKEN}" } : {}),
  };
}

export function droidProxyStartArgs(port: number): string[] {
  return ["start", "--port", String(port), "--proxy-only"];
}

/** Read the running proxy's client-visible model rows (authenticated GET /api/models). */
export async function fetchDroidModels(
  port: number,
  timeoutMs = 4_000,
): Promise<DroidRoutedModel[]> {
  try {
    const headers = new Headers();
    const token = configuredAdminToken();
    if (token) headers.set("x-opencodex-api-key", token);
    const res = await fetch(`http://127.0.0.1:${port}/api/models`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{
      provider?: string;
      id?: string;
      namespaced?: string;
      disabled?: boolean;
      displayName?: string;
      native?: boolean;
      inputModalities?: string[];
    }>;
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(
        (row) =>
          row &&
          row.disabled !== true &&
          row.native !== true &&
          typeof row.id === "string",
      )
      .map((row) => ({
        provider: row.provider ?? "openai",
        id: row.namespaced ?? row.id!,
        displayName: row.displayName,
        inputModalities: Array.isArray(row.inputModalities)
          ? row.inputModalities.filter(
              (v): v is string => typeof v === "string",
            )
          : undefined,
      }));
  } catch {
    return [];
  }
}

async function ensureProxyForDroid(): Promise<number | null> {
  const live = await findLiveProxy();
  if (live) return live.port;
  const cfgPort = loadConfig().port;
  const pinPort = typeof cfgPort === "number" && cfgPort > 0 ? cfgPort : 10100;
  const child = spawn(
    process.execPath,
    [process.argv[1], ...droidProxyStartArgs(pinPort)],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, OCX_SERVICE: "1" },
    },
  );
  child.on("error", () => {
    // A failed detached start is handled by the bounded proxy health poll.
  });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const started = await findLiveProxy();
    if (started) return started.port;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

const DROID_INSTALL_HINT =
  "❌ `droid` CLI not found. Install it first: https://docs.factory.com/droid-cli/quickstart";

export async function cmdDroid(args: string[]): Promise<number> {
  const config = loadConfig();
  const port = await ensureProxyForDroid();
  if (!port) {
    console.error("❌ Proxy did not become healthy after starting.");
    return 1;
  }
  const models = await fetchDroidModels(port);
  if (models.length === 0) {
    console.error(
      "❌ No OCX-routed models available; refusing to launch Droid with an empty catalog.",
    );
    return 1;
  }
  const admission = droidAdmissionEnvironment(config);
  const overlay = buildDroidSettingsOverlay(config, port, models, {
    apiKeyRef: admission.apiKeyRef,
  });
  const dir = mkdtempSync(join(tmpdir(), "ocx-droid-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(overlay, null, 2), {
    mode: 0o600,
  });
  const childArgs = ["--settings", settingsPath, ...args];
  try {
    return await new Promise<number>((resolve) => {
      const inv = commandInvocation("droid", childArgs, process.platform);
      const child = spawn(inv.file, inv.args, {
        stdio: "inherit",
        env: admission.env,
        ...inv.options,
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        console.error(
          err.code === "ENOENT"
            ? DROID_INSTALL_HINT
            : `❌ Failed to launch droid: ${err.message}`,
        );
        resolve(1);
      });
      child.on("exit", (code, signal) => {
        if (process.platform === "win32" && code === 9009 && !signal) {
          console.error(DROID_INSTALL_HINT);
          return resolve(1);
        }
        resolve(signal ? 1 : (code ?? 0));
      });
    });
  } finally {
    // The overlay holds the model table, never a secret value; still, remove it.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup: the temp file is mode 0600 and carries no credential.
    }
  }
}
