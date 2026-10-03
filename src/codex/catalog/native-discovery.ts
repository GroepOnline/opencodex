import type { OcxConfig } from "../../types";
import {
  MODEL_DISCOVERY_MAX_MODEL_ID_LENGTH,
  MODEL_DISCOVERY_MAX_MODELS,
  MODEL_DISCOVERY_MAX_RESPONSE_BYTES,
  extractModelEnvelopeRows,
  readBoundedDiscoveryJson,
} from "../../providers/model-discovery";
import { isSelectableCodexPoolAccount, MAIN_CODEX_ACCOUNT_ID } from "../account-id";
import { getValidCodexToken } from "../account-store";
import { getMainAccountToken } from "../main-account";
import { getEffectiveActiveCodexAccountId } from "../routing";
import { resolveCodexRuntime } from "../runtime";
import type { RawEntry } from "./parsing";

const NATIVE_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";
const NATIVE_MODEL_ID_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

type NativeCredential = {
  accessToken: string;
  chatgptAccountId: string;
};

type NativePoolToken = NativeCredential & {
  generation: number;
};

export interface NativeOpenAiCatalogDiscovery {
  models: RawEntry[];
  clientVersion: string | null;
}

export interface NativeOpenAiCatalogDiscoveryDeps {
  fetch?: typeof fetch;
  getEffectiveActiveCodexAccountId?: (config: OcxConfig) => string | undefined;
  getMainAccountToken?: () => NativeCredential | null;
  getValidCodexToken?: (id: string) => Promise<NativePoolToken>;
  resolveClientVersion?: () => string | null;
}

type CredentialCandidate =
  | { kind: "main" }
  | { kind: "pool"; id: string };

function defaultClientVersion(): string | null {
  return resolveCodexRuntime({ discoverAlternatives: false }).runtime.version;
}

function credentialCandidates(
  config: OcxConfig,
  selectedId: string | undefined,
): CredentialCandidate[] {
  const paused = new Set(config.pausedCodexAccountIds ?? []);
  const poolIds = (config.codexAccounts ?? [])
    .filter(isSelectableCodexPoolAccount)
    .map(account => account.id)
    .filter(id => !paused.has(id));

  const selectedPool = selectedId
    && selectedId !== MAIN_CODEX_ACCOUNT_ID
    && poolIds.includes(selectedId)
    ? selectedId
    : undefined;

  const out: CredentialCandidate[] = [];
  if (selectedPool) out.push({ kind: "pool", id: selectedPool });
  if (!paused.has(MAIN_CODEX_ACCOUNT_ID)) out.push({ kind: "main" });
  for (const id of poolIds) {
    if (id !== selectedPool) out.push({ kind: "pool", id });
  }
  return out;
}

async function resolveCredential(
  candidate: CredentialCandidate,
  deps: Required<Pick<
    NativeOpenAiCatalogDiscoveryDeps,
    "getMainAccountToken" | "getValidCodexToken"
  >>,
): Promise<NativeCredential | null> {
  if (candidate.kind === "main") return deps.getMainAccountToken();
  try {
    const token = await deps.getValidCodexToken(candidate.id);
    return {
      accessToken: token.accessToken,
      chatgptAccountId: token.chatgptAccountId,
    };
  } catch {
    return null;
  }
}

function validatedNativeModels(value: unknown): RawEntry[] | null {
  const envelope = extractModelEnvelopeRows(value, MODEL_DISCOVERY_MAX_MODELS, ["models"]);
  if (!envelope.ok) return null;

  const models: RawEntry[] = [];
  const seen = new Set<string>();
  for (const raw of envelope.rows) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const entry = raw as RawEntry;
    const slug = entry.slug;
    if (
      typeof slug !== "string"
      || !slug
      || slug !== slug.trim()
      || slug.length > MODEL_DISCOVERY_MAX_MODEL_ID_LENGTH
      || NATIVE_MODEL_ID_CONTROL_CHARS.test(slug)
    ) {
      return null;
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    const clone = { ...entry };
    // The request is already version-filtered for the installed Codex runtime. Keeping this
    // field would make a proxy serving another compatible Codex build hide an otherwise usable row.
    delete clone.minimal_client_version;
    models.push(clone);
  }
  return models;
}

/**
 * Fetch the native Codex model catalog with the credential OCX is actually routing through.
 *
 * This intentionally never rewrites ~/.codex/auth.json. A selected pool account is tried first;
 * otherwise the physical Desktop login is tried first. Authentication failures and invalid
 * responses fall through to the remaining pool credentials, and total failure leaves the
 * snapshot-backed catalog path untouched.
 */
export async function discoverNativeOpenAiCatalog(
  config: OcxConfig,
  injected: NativeOpenAiCatalogDiscoveryDeps = {},
): Promise<NativeOpenAiCatalogDiscovery> {
  const deps = {
    fetch: injected.fetch ?? fetch,
    getEffectiveActiveCodexAccountId:
      injected.getEffectiveActiveCodexAccountId ?? getEffectiveActiveCodexAccountId,
    getMainAccountToken: injected.getMainAccountToken ?? getMainAccountToken,
    getValidCodexToken: injected.getValidCodexToken ?? getValidCodexToken,
    resolveClientVersion: injected.resolveClientVersion ?? defaultClientVersion,
  };

  const clientVersion = deps.resolveClientVersion();
  if (!clientVersion) return { models: [], clientVersion: null };

  const url = new URL(NATIVE_MODELS_ENDPOINT);
  url.searchParams.set("client_version", clientVersion);

  const candidates = credentialCandidates(
    config,
    deps.getEffectiveActiveCodexAccountId(config),
  );
  for (const candidate of candidates) {
    const credential = await resolveCredential(candidate, deps);
    if (!credential?.accessToken || !credential.chatgptAccountId) continue;

    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          "chatgpt-account-id": credential.chatgptAccountId,
          originator: "codex_cli_rs",
          version: clientVersion,
        },
      });
    } catch {
      continue;
    }

    if (!response.ok) {
      try {
        void response.body?.cancel();
      } catch {
        // Best-effort body cleanup only.
      }
      continue;
    }

    const parsed = await readBoundedDiscoveryJson(
      response,
      MODEL_DISCOVERY_MAX_RESPONSE_BYTES,
    );
    if (!parsed.ok) continue;
    const models = validatedNativeModels(parsed.value);
    if (!models) continue;
    return { models, clientVersion };
  }

  return { models: [], clientVersion };
}

/** Replace same-slug native rows with live authoritative rows and append newly rolled-out ones. */
export function mergeDiscoveredNativeCatalogRows(
  catalogModels: RawEntry[],
  discoveredModels: RawEntry[],
): RawEntry[] {
  if (discoveredModels.length === 0) return catalogModels;

  const bySlug = new Map(
    discoveredModels.flatMap(model =>
      typeof model.slug === "string" && !model.slug.includes("/")
        ? [[model.slug, model] as const]
        : []
    ),
  );
  if (bySlug.size === 0) return catalogModels;

  const merged = catalogModels.map(model => {
    const slug = typeof model.slug === "string" && !model.slug.includes("/")
      ? model.slug
      : undefined;
    if (!slug) return model;
    const replacement = bySlug.get(slug);
    if (!replacement) return model;
    bySlug.delete(slug);
    return replacement;
  });
  return [...merged, ...bySlug.values()];
}
