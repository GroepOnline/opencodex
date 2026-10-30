import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function read(rel: string): Promise<string> {
  return Bun.file(join(repoRoot, rel)).text();
}

describe("local runtime without GitHub Actions", () => {
  test("the runner script can start compose or k3s and does not call GitHub", async () => {
    const script = await read("scripts/local-runtime.sh");
    expect(script).toContain("docker compose up -d --build");
    expect(script).toContain("deploy/k3s/opencodex.yaml");
    expect(script).toContain("127.0.0.1:10100/healthz");
    expect(script).not.toContain("github.com");
    expect(script).not.toContain("OPENCODEX_API_AUTH_TOKEN=");
    expect(script).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}\b/);
  });

  test("the k3s manifest stays loopback-forwarded and secret-free", async () => {
    const manifest = await read("deploy/k3s/opencodex.yaml");
    expect(manifest).toContain("image: opencodex:local");
    expect(manifest).toContain("imagePullPolicy: Never");
    expect(manifest).toContain("readOnlyRootFilesystem: true");
    expect(manifest).toContain("automountServiceAccountToken: false");
    expect(manifest).toContain("secretKeyRef:");
    expect(manifest).not.toContain("ghcr.io");
    expect(manifest).not.toMatch(/[0-9a-f]{40}/);
    expect(manifest).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}\b/);
  });

  test("the observability compose profile publishes ClickHouse on loopback only", async () => {
    const compose = await read("compose.yml");
    expect(compose).toContain('profiles: ["observability"]');
    expect(compose).toContain('"127.0.0.1:8123:8123"');
    expect(compose).toContain("clickhouse-local.xml");
    expect(compose).not.toMatch(/^(\s*)CLICKHOUSE_PASSWORD:/m);
    expect(compose).toContain("OCX_DATADOG_API_KEY: ${OCX_DATADOG_API_KEY:-}");
    expect(compose).toContain(
      "OCX_CLICKHOUSE_PASSWORD_FILE: ${OCX_CLICKHOUSE_PASSWORD_FILE:-}",
    );
  });
});
