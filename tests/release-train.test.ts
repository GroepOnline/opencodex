import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL("../" + path, import.meta.url)).text();

describe("OpenCodex automated release train", () => {
  test("only trusted main gets write tokens, with a serialized train", async () => {
    const text = await read(".github/workflows/release-train.yml");
    const workflow = Bun.YAML.parse(text) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      concurrency: { group: string; "cancel-in-progress": boolean };
      jobs: Record<string, {
        if: string;
        "timeout-minutes": number;
        permissions: Record<string, string>;
      }>;
    };
    expect(workflow.permissions).toEqual({});
    expect(workflow.on).toHaveProperty("push");
    expect(workflow.on).toHaveProperty("schedule");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.concurrency).toEqual({ group: "ocx-release-train-main", "cancel-in-progress": false });
    const job = workflow.jobs.publish!;
    expect(job.if).toBe("github.repository == 'GroepOnline/opencodex' && github.ref == 'refs/heads/main'");
    expect(job["timeout-minutes"]).toBe(180);
    expect(job.permissions).toEqual({ contents: "write", actions: "write" });
    expect(text).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("full CI and exact image identity are mandatory for a successful release", async () => {
    const workflow = await read(".github/workflows/release-train.yml");
    const script = await read("scripts/release.ts");
    expect(workflow).toContain("bun scripts/release.ts --resume --publish");
    expect(workflow).toContain("bun scripts/release.ts --publish");
    expect(script).toContain('const resume = args.includes("--resume")');
    expect(script).toContain("gh workflow run");
    expect(script).toContain("SERVICE_WORKFLOW");
    expect(script).toContain("await assertUnusedReleaseVersion(packageName, version)");
    expect(script).toContain("await watchRun(releaseRun.databaseId)");
    expect(workflow).toContain("gh run download");
    expect(workflow).toContain(".imageRunId == $run");
    expect(workflow).toContain(".sourceSha == $sha");
    expect(workflow).toContain('test("^sha256:[0-9a-f]{64}$")');
    expect(workflow).not.toContain("npm publish --force");
    expect(workflow).not.toContain("git push --force");
  });

  test("skips superseded commits and documentation-only changes", async () => {
    const text = await read(".github/workflows/release-train.yml");
    expect(text).toContain('if [ "$current_sha" != "$remote_sha" ]; then');
    expect(text).toContain("git diff --name-only");
    expect(text).toContain("No releasable changes");
    expect(text).toContain("mode=resume");
    expect(text).toContain("mode=next");
    expect(text).toContain("ship=false");
  });
});
