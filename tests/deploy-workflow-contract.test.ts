import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

type DeployStep = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
};

type DeployWorkflow = {
  name?: string;
  on?: {
    push?: unknown;
    workflow_dispatch?: { inputs?: Record<string, unknown> } | null;
  };
  permissions?: Record<string, string>;
  concurrency?: unknown;
  jobs?: Record<
    string,
    {
      "runs-on"?: string[];
      "timeout-minutes"?: number;
      env?: Record<string, string>;
      steps?: DeployStep[];
    }
  >;
};

async function deployText(): Promise<string> {
  return await Bun.file(new URL(".github/workflows/deploy.yml", root)).text();
}

async function deployWorkflow(): Promise<DeployWorkflow> {
  return Bun.YAML.parse(await deployText()) as DeployWorkflow;
}

describe("retired deploy workflow contract", () => {
  test("is manual-only and cannot be re-armed by a release tag", async () => {
    const workflow = await deployWorkflow();

    expect(workflow.name).toBe("Legacy deploy route retired");
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(workflow.on?.push).toBeUndefined();
    expect(workflow.on?.workflow_dispatch?.inputs).toBeUndefined();

    // The old concurrency group belongs to a live cutover. Keeping it here
    // would imply that an accidental refusal run can still serialize a deploy.
    expect(workflow.concurrency).toBeUndefined();
  });

  test("fails closed with a bounded refusal and no deployment side effects", async () => {
    const workflow = await deployWorkflow();
    expect(Object.keys(workflow.jobs ?? {})).toEqual(["retired"]);

    const retired = workflow.jobs?.retired;
    expect(retired?.["runs-on"]).toEqual([
      "self-hosted",
      "Linux",
      "X64",
      "jan",
    ]);
    expect(retired?.["timeout-minutes"]).toBe(5);
    expect(retired?.env).toBeUndefined();
    expect(retired?.steps).toHaveLength(1);

    const refusal = retired?.steps?.[0];
    expect(refusal?.name).toBe("Refuse retired deployment route");
    expect(refusal?.uses).toBeUndefined();
    expect(refusal?.env).toBeUndefined();
    expect(refusal?.run).toContain(
      "The chef-control-az-01 deployment route is permanently retired.",
    );
    expect(refusal?.run).toContain(
      "use the separately verified bc-scan-2 package deployment contract",
    );
    expect(refusal?.run?.trim().endsWith("exit 1")).toBe(true);
  });

  test("retains no credentials, package access, host paths, or rollout machinery", async () => {
    const text = await deployText();
    const workflow = await deployWorkflow();

    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.permissions).not.toHaveProperty("packages");
    expect(workflow.permissions).not.toHaveProperty("actions");
    expect(workflow.permissions).not.toHaveProperty("id-token");

    for (const forbidden of [
      "secrets.",
      "GH_TOKEN",
      "packages: read",
      "actions: write",
      "id-token:",
      "ghcr.io",
      "docker login",
      "docker pull",
      "docker compose",
      "systemctl",
      "curl ",
      "bun install",
      "npm publish",
      "gh workflow run",
      "/opt/chef/",
      "/etc/opencodex/",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/uses:\s*\S+@/);
  });

  test("release and runbook copy preserve the publish/cutover boundary", async () => {
    const releaseProcess = await Bun.file(
      new URL("RELEASE_PROCESS.md", root),
    ).text();
    const containerReadme = await Bun.file(
      new URL("deploy/container/README.md", root),
    ).text();
    const publishOnTag = await Bun.file(
      new URL(".github/workflows/publish-on-tag.yml", root),
    ).text();

    expect(releaseProcess).toContain(
      "leave the `deploy` input at its default `false`",
    );
    expect(releaseProcess).toContain(
      "Runtime cutover is intentionally not part of release publication",
    );
    expect(releaseProcess).not.toContain("gh workflow run deploy.yml");

    expect(containerReadme).toContain("retired fail-closed");
    expect(containerReadme).toContain("separate operation");
    expect(containerReadme).not.toContain("OPENCODEX_IMAGE");

    expect(publishOnTag).toContain("Publication does not deploy a runtime");
    expect(publishOnTag).toContain(
      "Runtime cutover is a separately verified operation",
    );
    expect(publishOnTag).not.toContain("DEPLOY_HOST");
    expect(publishOnTag).not.toContain("DEPLOY_SSH_KEY");
  });
});
