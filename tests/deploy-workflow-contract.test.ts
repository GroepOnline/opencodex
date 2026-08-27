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

  test("dispatch checkout and deploy identity are pinned to the validated tag commit", async () => {
    const workflow = await deployWorkflow();
    expect(workflow).toContain("ref: ${{ steps.ref.outputs.tag }}");
    expect(workflow).toContain('tag_sha=$(git rev-parse "refs/tags/$tag")');
    expect(workflow).toContain('tag_sha=$(git rev-parse "refs/tags/$tag^{}")');
    expect(workflow).toContain('echo "tag_sha=$tag_sha" >> "$GITHUB_OUTPUT"');
  });

  test("rollback remains armed after cutover starts even if start fails", async () => {
    const workflow = await deployWorkflow();
    expect(workflow).toContain('echo "cutover_started=true" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain("steps.deploy.outputs.cutover_started == 'true'");
    expect(workflow).toContain("(failure() || cancelled())");
    expect(workflow).not.toContain("steps.deploy.outcome == 'success'");
    const deployScript = workflow.slice(
      workflow.indexOf("- name: Deploy digest-pinned container"),
      workflow.indexOf("- name: Health gate"),
    );
    expect(deployScript.indexOf("cutover_started=true")).toBeLessThan(deployScript.indexOf("sudo mkdir -p"));
  });

  test("health probes loopback only while Tailscale remains a host presence gate", async () => {
    const workflow = await deployWorkflow();
    const resolve = workflow.slice(
      workflow.indexOf("- name: Resolve health URLs"),
      workflow.indexOf("- name: Wait for GHCR publish"),
    );
    expect(resolve).toContain("http://127.0.0.1:10100/healthz");
    expect(resolve).toContain("tailscale ip -4");
    expect(resolve).not.toContain('urls="$urls http://${ts_ip}:10100/healthz"');
    expect(workflow).toContain("OPENCODEX_BIND_IP=127.0.0.1");
  });

  test("bun-runtime rollback passes the compose env file explicitly", async () => {
    const workflow = await deployWorkflow();
    expect(workflow).toContain(
      'sudo docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_DIR/docker-compose.yml" down',
    );
    expect(workflow).not.toContain(
      'sudo docker compose -f "$COMPOSE_DIR/docker-compose.yml" down',
    );
  });

  test("previous digest fallback inspects the running image, not the container", async () => {
    const workflow = await deployWorkflow();
    expect(workflow).toContain("docker inspect --format='{{.Image}}'");
    expect(workflow).toContain("docker image inspect --format='{{index .RepoDigests 0}}'");
    expect(workflow).not.toContain("docker inspect --format='{{index .RepoDigests 0}}'");
  });
});
