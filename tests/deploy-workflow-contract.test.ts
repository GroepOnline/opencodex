import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function deployWorkflow(): Promise<string> {
  return await Bun.file(new URL(".github/workflows/deploy.yml", root)).text();
}

describe("digest deploy workflow contract", () => {
  test("can inspect Actions runs with least privilege", async () => {
    const workflow = await deployWorkflow();
    expect(workflow).toContain("permissions:\n  contents: read\n  packages: read\n  actions: read");
    expect(workflow).toContain("gh run list --workflow container.yml");
    expect(workflow).toContain("gh run view");
  });

  test("rollback remains armed after cutover starts even if start fails", async () => {
    const workflow = await deployWorkflow();
    expect(workflow).toContain('echo "cutover_started=true" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain("steps.deploy.outputs.cutover_started == 'true'");
    expect(workflow).not.toContain("steps.deploy.outcome == 'success'");
    const deployScript = workflow.slice(
      workflow.indexOf("- name: Deploy digest-pinned container"),
      workflow.indexOf("- name: Health gate"),
    );
    expect(deployScript.indexOf("cutover_started=true")).toBeLessThan(deployScript.indexOf("sudo mkdir -p"));
  });

  test("previous digest fallback inspects the running image, not the container", async () => {
    const workflow = await deployWorkflow();
    expect(workflow).toContain("docker inspect --format='{{.Image}}'");
    expect(workflow).toContain("docker image inspect --format='{{index .RepoDigests 0}}'");
    expect(workflow).not.toContain("docker inspect --format='{{index .RepoDigests 0}}'");
  });
});
