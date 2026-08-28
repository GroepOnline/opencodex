import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

describe("Cloudflare Access container deploy contract", () => {
  test("compose forwards Access verifier settings into the runtime", async () => {
    const compose = await Bun.file(
      new URL("deploy/container/compose.example.yml", root),
    ).text();
    expect(compose).toContain(
      "CF_ACCESS_TEAM_DOMAIN: ${CF_ACCESS_TEAM_DOMAIN:-}",
    );
    expect(compose).toContain("CF_ACCESS_AUD: ${CF_ACCESS_AUD:-}");
    expect(compose).toContain(
      "CF_ACCESS_ALLOWED_HOSTS: ${CF_ACCESS_ALLOWED_HOSTS:-}",
    );
  });

  test("digest deploy and rollback write the trusted OCX Access identity from secrets", async () => {
    const workflow = await Bun.file(
      new URL(".github/workflows/deploy.yml", root),
    ).text();
    // Both deploy and rollback steps must reference the CF Access env vars,
    // sourced from GitHub secrets rather than hardcoded deployment values.
    expect(
      workflow.match(/CF_ACCESS_TEAM_DOMAIN/g)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(workflow.match(/CF_ACCESS_AUD/g)?.length).toBeGreaterThanOrEqual(4);
    expect(
      workflow.match(/CF_ACCESS_ALLOWED_HOSTS/g)?.length,
    ).toBeGreaterThanOrEqual(4);
    // No hardcoded deployment-specific values in the workflow.
    expect(workflow).not.toContain("chefgroep.cloudflareaccess.com");
    expect(workflow).not.toContain(
      "113d678ff9b96cabf41e8e2076166fa692bc078db28e792019c9302fa0e53286",
    );
    expect(workflow).not.toContain("ocx.chefgroep.online");
  });
});
