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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config";
import { commandInvocation } from "../lib/win-exec";
import { findLiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";

/** One custom-model row in Factory's `customModels` schema (BYOK reference). */
export interface DroidCustomModel {
  model: string;
  displayName: string;
  baseUrl: string;
  provider: "openai" | "anthropic" | "generic-chat-completion-api";
  apiKey: string;
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
}

/**
 * Reduce a routed proxy model id to the bare model id Droid must send upstream.
 * OCX's canonical selector is `<provider>/<model>`; the proxy strips the routing
 * namespace at its own boundary, so Factory is given the model portion only.
 */
export function droidModelId(routed: string): string {
  const slash = routed.lastIndexOf("/");
  return slash >= 0 ? routed.slice(slash + 1) : routed;
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
  const apiKey = options.apiKeyRef ?? "${OCX_ADMISSION_TOKEN}";
  const rows: DroidCustomModel[] = models
    .filter((model) => typeof model.id === "string" && model.id.length > 0)
    .map((model) => ({
      model: droidModelId(model.id),
      displayName:
        model.displayName && model.displayName.length > 0
          ? model.displayName
          : `OCX / ${droidModelId(model.id)}`,
      baseUrl,
      provider: "openai" as const,
      apiKey,
      maxOutputTokens: 128_000,
      noImageSupport: true,
    }));
  const preferred =
    config.injectionModel &&
    rows.some((row) => row.model === droidModelId(config.injectionModel!))
      ? droidModelId(config.injectionModel)
      : (rows[0]?.model ?? "");
  return { model: preferred, customModels: rows };
}

/** Read the running proxy's client-visible model rows (authenticated GET /api/models). */
export async function fetchDroidModels(
  port: number,
  timeoutMs = 4_000,
): Promise<DroidRoutedModel[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{
      provider?: string;
      id?: string;
      namespaced?: string;
      disabled?: boolean;
      displayName?: string;
    }>;
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(
        (row) => row && row.disabled !== true && typeof row.id === "string",
      )
      .map((row) => ({
        provider: row.provider ?? "openai",
        id: row.namespaced ?? row.id!,
        displayName: row.displayName,
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
    [process.argv[1], "start", "--port", String(pinPort)],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, OCX_SERVICE: "1" },
    },
  );
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
      "⚠ No OCX models were returned by the proxy; launching with an empty overlay.",
    );
  }
  const overlay = buildDroidSettingsOverlay(config, port, models, {
    apiKeyRef: process.env.OCX_ADMISSION_TOKEN
      ? "${OCX_ADMISSION_TOKEN}"
      : undefined,
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
        env: process.env,
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
      child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 0)));
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
