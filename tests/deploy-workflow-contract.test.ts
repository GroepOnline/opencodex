import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

type DeployStep = {
  name?: string;
  id?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  run?: string;
};

async function deployWorkflow(): Promise<string> {
  return await Bun.file(new URL(".github/workflows/deploy.yml", root)).text();
}

async function deploySteps(): Promise<DeployStep[]> {
  const parsed = Bun.YAML.parse(await deployWorkflow()) as {
    jobs?: { deploy?: { steps?: DeployStep[] } };
  };
  return parsed.jobs?.deploy?.steps ?? [];
}

describe("digest deploy workflow contract", () => {
  test("can inspect Actions runs with least privilege", async () => {
    const workflow = await deployWorkflow();
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("packages: read # GHCR digest pull");
    expect(workflow).toContain("actions: read # gh run list/view container.yml publish");
    expect(workflow).toContain("gh run list --workflow container.yml");
    expect(workflow).toContain("gh run view");
    expect(workflow).toContain("sort_by(.createdAt) | reverse");
    expect(workflow).toContain("timed_out");
    expect(workflow).toContain("skipped|none");
    expect(workflow).toContain("sudo docker logout ghcr.io");
    expect(workflow).toContain('sudo sha256sum "$token_file"');

    const checkouts = (await deploySteps()).filter(step => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(2);
    for (const checkout of checkouts) {
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    }
  });

  test("dispatch checkout and deploy identity are pinned to the validated tag commit", async () => {
    const workflow = await deployWorkflow();
    expect(workflow).not.toContain("ref: ${{ steps.ref.outputs.tag }}");
    expect(workflow).toContain("ref: ${{ steps.verify.outputs.tag_sha }}");
    const verify = (await deploySteps()).find(step => step.id === "verify");
    const assigns = [...(verify?.run ?? "").matchAll(/tag_sha=\$\(git rev-parse [^)]+\)/g)].map(
      match => match[0],
    );
    expect(assigns).toEqual(['tag_sha=$(git rev-parse "refs/tags/$tag^{}")']);
    expect(workflow).toContain('echo "tag_sha=$tag_sha" >> "$GITHUB_OUTPUT"');
    expect(workflow.indexOf("- name: Verify tag is on origin/main")).toBeLessThan(
      workflow.indexOf("- name: Checkout peeled tag commit"),
    );
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

  test("host publish includes Tailscale IPv4; health requires loopback and that address", async () => {
    const workflow = await deployWorkflow();
    const compose = await Bun.file(new URL("deploy/container/compose.example.yml", root)).text();
    const resolve = workflow.slice(
      workflow.indexOf("- name: Resolve health URLs"),
      workflow.indexOf("- name: Wait for GHCR publish"),
    );
    expect(resolve).toContain("http://127.0.0.1:10100/healthz");
    expect(resolve).toContain("tailscale ip -4");
    expect(resolve).toContain('urls="$urls http://${ts_ip}:10100/healthz"');
    expect(resolve).toContain("OPENCODEX_BIND_IP=$ts_ip");
    expect(workflow).toContain("printf 'OPENCODEX_BIND_IP=%s\\n' \"$OPENCODEX_BIND_IP\"");
    expect(workflow).not.toContain("OPENCODEX_BIND_IP=127.0.0.1");
    expect(workflow).not.toContain("100.109.39.86");
    expect(workflow).toContain('OCX_HEALTH_URLS must include loopback and Tailscale');
    expect(workflow).toContain('read -r -a health_urls <<< "$OCX_HEALTH_URLS"');
    expect(workflow).not.toContain("set -- $OCX_HEALTH_URLS");
    expect(compose).toContain('"127.0.0.1:10100:10100"');
    expect(compose).toContain("${OPENCODEX_BIND_IP:?set the host Tailscale IPv4}:10100:10100");
  });

  test("bun-runtime rollback wins over a stale compose image and probes any healthy URL", async () => {
    const workflow = await deployWorkflow();
    const rollback = workflow.slice(
      workflow.indexOf("- name: Rollback on failure"),
      workflow.indexOf("- name: Log out of GHCR"),
    );
    expect(rollback.indexOf('bun_runtime="${{ steps.prev.outputs.bun_runtime }}"')).toBeLessThan(
      rollback.indexOf('elif [ -n "$prev_image" ]'),
    );
    expect(rollback).toContain('[ "$bun_runtime" = "true" ]');
    expect(rollback).toContain("bun runtime detected but unit backup missing");
    expect(rollback).not.toContain('[ "$bun_runtime" = "true" ] && [ -n "$unit_backup" ]');
    expect(rollback).toContain('read -r -a rollback_urls <<< "$urls"');
    expect(rollback).toContain('echo "rolled back and healthy with GUI via $url"');
    expect(rollback).not.toContain("all_ok=1");
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
