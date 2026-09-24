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
    expect(compose).toContain("OIDC_ISSUER: ${OIDC_ISSUER:-}");
    expect(compose).toContain(
      "OIDC_CLIENT_SECRET_FILE: ${OIDC_CLIENT_SECRET_FILE:-}",
    );
    expect(compose).toContain("OIDC_ALLOWED_HOSTS: ${OIDC_ALLOWED_HOSTS:-}");
  });

  test("retired deploy workflow retains no Access secrets or cutover state", async () => {
    const workflow = await Bun.file(
      new URL(".github/workflows/deploy.yml", root),
    ).text();
    for (const name of ["TEAM_DOMAIN", "AUD", "ALLOWED_HOSTS"]) {
      expect(workflow).not.toContain(`secrets.OCX_CF_ACCESS_${name}`);
      expect(workflow).not.toContain(`CF_ACCESS_${name}=`);
    }
    expect(workflow).not.toContain("secret+live merge");
    expect(workflow).not.toContain("cutover_started=true");
    expect(workflow).not.toContain("chefgroep.cloudflareaccess.com");
    expect(workflow).not.toContain(
      "113d678ff9b96cabf41e8e2076166fa692bc078db28e792019c9302fa0e53286",
    );
    expect(workflow).not.toContain("ocx.chefgroep.online");
  });
});
