import { createOpenAIChatAdapter } from "./openai-chat";
import { resolveEnvValue } from "../config";
import type { ProviderAdapter } from "./base";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import { createHash, createHmac } from "node:crypto";

/**
 * AWS Bedrock adapter: SigV4-signed OpenAI-compatible chat completions.
 *
 * Bedrock exposes an OpenAI-compatible surface at
 * `https://bedrock-runtime.<region>.amazonaws.com/openai/v1/chat/completions`,
 * but it authenticates with AWS SigV4 instead of a bearer key. This adapter keeps
 * the full openai-chat wire (tools, reasoning, compat) and replaces the auth
 * headers with a per-request SigV4 signature for service `bedrock`.
 *
 * Credentials: `awsAccessKeyId` / `awsSecretAccessKey` / optional `awsSessionToken`,
 * each optionally an `$ENV` reference (resolved per request via resolveEnvValue).
 * Region comes from the `bedrock-runtime.<region>.amazonaws.com` host or an explicit
 * `awsRegion` override (non-AWS partitions must set `awsRegion` and the partition host).
 */

interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}

function resolveAwsField(value: string | undefined, label: string): string {
  const resolved = resolveEnvValue(value);
  if (!resolved || resolved.trim() === "") {
    throw new Error(
      `bedrock adapter requires a non-empty ${label} (inline or $ENV reference)`,
    );
  }
  return resolved.trim();
}

export function resolveBedrockCredentials(
  provider: OcxProviderConfig,
): AwsCreds {
  const host = new URL(provider.baseUrl).hostname;
  const regionMatch = host.match(
    /^bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com$/,
  );
  const region =
    resolveEnvValue(provider.awsRegion)?.trim() || regionMatch?.[1] || "";
  if (!region) {
    throw new Error(
      `bedrock adapter cannot derive an AWS region from baseUrl host "${host}" — set awsRegion`,
    );
  }
  return {
    accessKeyId: resolveAwsField(provider.awsAccessKeyId, "awsAccessKeyId"),
    secretAccessKey: resolveAwsField(
      provider.awsSecretAccessKey,
      "awsSecretAccessKey",
    ),
    sessionToken:
      resolveEnvValue(provider.awsSessionToken)?.trim() || undefined,
    region,
  };
}

function hmac(key: Buffer | string, data: string): Buffer {
  // AWS SigV4 key derivation: HMAC-SHA256 is mandated by the protocol, not password hashing.
  // lgtm[js/insufficient-password-hash]
  // codeql[js/insufficient-password-hash]
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Core SigV4 signing chain. Exported for deterministic tests against AWS's
 * canonical signing examples; production callers use `sigv4Headers`.
 */
export function sigv4(
  creds: Pick<AwsCreds, "accessKeyId" | "secretAccessKey" | "sessionToken">,
  region: string,
  service: string,
  method: string,
  pathAndQuery: string,
  headers: Record<string, string>,
  payload: string,
  amzDate: string,
): { authorization: string; amzDate: string } {
  const [path, query = ""] = pathAndQuery.split("?");
  const payloadHash = sha256Hex(payload);

  const signed: Record<string, string> = {
    host: headers.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(creds.sessionToken
      ? { "x-amz-security-token": creds.sessionToken }
      : {}),
  };
  const sortedNames = Object.keys(signed).sort();
  const canonicalHeaders = sortedNames
    .map((n) => `${n}:${signed[n]}\n`)
    .join("");
  const signedHeaders = sortedNames.join(";");
  const canonicalRequest = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  let key = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  key = hmac(key, region);
  key = hmac(key, service);
  key = hmac(key, "aws4_request");
  // SigV4 final signature: HMAC-SHA256 is the protocol definition (see hmac() note).
  // lgtm[js/insufficient-password-hash]
  // codeql[js/insufficient-password-hash]
  const signature = createHmac("sha256", key)
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
  };
}

function sigv4Headers(
  creds: AwsCreds,
  url: URL,
  method: string,
  payload: string,
): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const pathAndQuery = `${url.pathname}${url.search}`;
  const { authorization } = sigv4(
    creds,
    creds.region,
    "bedrock",
    method,
    pathAndQuery,
    { host: url.host },
    payload,
    amzDate,
  );
  return {
    Authorization: authorization,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": sha256Hex(payload),
    ...(creds.sessionToken
      ? { "x-amz-security-token": creds.sessionToken }
      : {}),
  };
}

export function createBedrockAdapter(
  provider: OcxProviderConfig,
): ProviderAdapter {
  // SigV4 replaces the bearer credential; the inner openai-chat wire must not require one.
  const inner = createOpenAIChatAdapter({ ...provider, keyOptional: true });
  return {
    ...inner,
    name: "bedrock",

    async buildRequest(parsed: OcxParsedRequest) {
      if (provider.authMode === "forward") {
        throw new Error("bedrock does not support forward auth mode");
      }
      const creds = resolveBedrockCredentials(provider);
      const request = await inner.buildRequest(parsed);
      const url = new URL(request.url);
      const body =
        typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body ?? "");
      const headers = {
        ...request.headers,
        ...sigv4Headers(creds, url, "POST", body),
      };
      return { ...request, headers, body };
    },
  };
}
