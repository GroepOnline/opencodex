import { describe, expect, test } from "bun:test";
import {
  createBedrockAdapter,
  resolveBedrockCredentials,
  sigv4,
} from "../src/adapters/bedrock";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const parsed: OcxParsedRequest = {
  modelId: "openai.gpt-oss-120b",
  context: { messages: [] },
  stream: true,
  options: {},
  _rawBody: { model: "openai.gpt-oss-120b", input: [], stream: true },
};

function provider(
  overrides: Partial<OcxProviderConfig> = {},
): OcxProviderConfig {
  return {
    adapter: "bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
    awsAccessKeyId: "AKIDEXAMPLE",
    awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ...overrides,
  };
}

describe("Bedrock adapter", () => {
  test("replaces bearer auth with SigV4 headers and derives region from the host", async () => {
    const request = await createBedrockAdapter(provider()).buildRequest(parsed);
    const url = new URL(request.url);

    expect(url.hostname).toBe("bedrock-runtime.us-east-1.amazonaws.com");
    expect(request.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=/,
    );
    expect(request.headers.Authorization).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(request.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(request.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(request.headers["x-amz-security-token"]).toBeUndefined();
    // openai-chat wire is preserved underneath.
    expect(JSON.parse(request.body).model).toBe("openai.gpt-oss-120b");
  });

  test("includes the session token header when configured", async () => {
    const request = await createBedrockAdapter(
      provider({
        awsSessionToken: "tok-123",
      }),
    ).buildRequest(parsed);

    expect(request.headers["x-amz-security-token"]).toBe("tok-123");
    expect(request.headers.Authorization).toContain("AKIDEXAMPLE/");
  });

  test("resolves $ENV credential references", () => {
    process.env.OCX_TEST_AWS_KEY = "AKIDENV";
    process.env.OCX_TEST_AWS_SECRET = "secret-env";
    const creds = resolveBedrockCredentials(
      provider({
        awsAccessKeyId: "$OCX_TEST_AWS_KEY",
        awsSecretAccessKey: "$OCX_TEST_AWS_SECRET",
      }),
    );
    expect(creds.accessKeyId).toBe("AKIDENV");
    expect(creds.secretAccessKey).toBe("secret-env");
    expect(creds.region).toBe("us-east-1");
  });

  test("fails closed on missing credentials and undeterminable region", () => {
    expect(() =>
      resolveBedrockCredentials(provider({ awsAccessKeyId: undefined })),
    ).toThrow(/awsAccessKeyId/);
    expect(() =>
      resolveBedrockCredentials(
        provider({
          baseUrl: "https://bedrock.example.internal/openai/v1",
        }),
      ),
    ).toThrow(/awsRegion/);
  });

  test("rejects forward auth mode", () => {
    expect(() =>
      createBedrockAdapter(provider({ authMode: "forward" })).buildRequest(
        parsed,
      ),
    ).toThrow(/forward/);
  });

  test("SigV4 output is deterministic and payload/date sensitive", () => {
    const creds = {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    };
    const a = sigv4(
      creds,
      "us-east-1",
      "bedrock",
      "POST",
      "/openai/v1/chat/completions",
      { host: "bedrock-runtime.us-east-1.amazonaws.com" },
      "{}",
      "20260929T120000Z",
    ).authorization;
    const b = sigv4(
      creds,
      "us-east-1",
      "bedrock",
      "POST",
      "/openai/v1/chat/completions",
      { host: "bedrock-runtime.us-east-1.amazonaws.com" },
      "{}",
      "20260929T120000Z",
    ).authorization;
    expect(b).toBe(a);
    const c = sigv4(
      creds,
      "us-east-1",
      "bedrock",
      "POST",
      "/openai/v1/chat/completions",
      { host: "bedrock-runtime.us-east-1.amazonaws.com" },
      '{"x":1}',
      "20260929T120000Z",
    ).authorization;
    expect(c).not.toBe(a);
    const d = sigv4(
      creds,
      "us-east-1",
      "bedrock",
      "POST",
      "/openai/v1/chat/completions",
      { host: "bedrock-runtime.us-east-1.amazonaws.com" },
      "{}",
      "20260929T120001Z",
    ).authorization;
    expect(d).not.toBe(a);
  });

  test("live Bedrock smoke (skipped without credentials)", async () => {
    const accessKeyId = process.env.OCX_TEST_AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.OCX_TEST_AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) return; // no real credentials in CI
    const request = await createBedrockAdapter(
      provider({
        awsAccessKeyId: accessKeyId,
        awsSecretAccessKey: secretAccessKey,
      }),
    ).buildRequest(parsed);
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });
    expect(response.status).toBe(200);
  });
});
