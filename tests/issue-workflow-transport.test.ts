import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const workflows = [
  [".github/workflows/enforce-issue-quality.yml", 3],
  [".github/workflows/issue-triage.yml", 1],
] as const;

function trustedCheckoutSteps(workflow: string): string[] {
  return workflow
    .split(/(?=^ {6}- name: )/m)
    .filter((block) => block.startsWith("      - name: Checkout trusted "));
}

describe("issue workflows: trusted checkout transport", () => {
  test("all jan checkouts force HTTP/1.1 without loosening checkout controls", () => {
    for (const [path, expectedCount] of workflows) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      expect(source).toContain("runs-on: [self-hosted, Linux, X64, jan]");
      const checkouts = trustedCheckoutSteps(source);
      expect(checkouts).toHaveLength(expectedCount);
      for (const checkout of checkouts) {
        const settings = checkout.slice(0, checkout.indexOf("\n      - name:", 1) >= 0
          ? checkout.indexOf("\n      - name:", 1)
          : undefined);
        expect(settings).toContain('        env:\n          GIT_CONFIG_COUNT: "1"');
        expect(settings).toContain("          GIT_CONFIG_KEY_0: http.version");
        expect(settings).toContain("          GIT_CONFIG_VALUE_0: HTTP/1.1");
        expect(settings).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v7\.0\.1/);
        expect(settings).toContain("persist-credentials: false");
        expect(settings).toContain("ref: ${{ github.event.repository.default_branch }}");
      }
    }
  });

  test("Git honors the step-scoped environment override", () => {
    const result = spawnSync("git", ["config", "--get", "http.version"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.version",
        GIT_CONFIG_VALUE_0: "HTTP/1.1",
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("HTTP/1.1");
  });
});
