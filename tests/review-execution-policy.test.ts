import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const policy = readFileSync(
  new URL("../MAINTAINERS.md", import.meta.url),
  "utf8",
);
const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const normalizedPolicy = policy.replace(/\s+/g, " ");
const normalizedAgents = agents.replace(/\s+/g, " ");

describe("review execution policy", () => {
  test("external approval is advisory without weakening technical verification", () => {
    expect(policy).toContain(
      "External review and GitHub approval are advisory",
    );
    expect(policy).toContain("failed or unknown required technical checks");
    expect(policy).toContain("explicit, recorded security analysis");
    expect(policy).toContain("protected-branch rules are not bypassed");
    expect(policy).not.toContain(
      "requires approval from at least one maintainer",
    );
    expect(agents).toContain("External approval is advisory, never a blocker");
  });

  test("technical checks apply to the exact head even without branch protection", () => {
    expect(normalizedPolicy).toContain(
      "Required technical checks must succeed on the exact head being merged, whether enforced by branch protection or by the operator.",
    );
    expect(normalizedAgents).toContain(
      "Required technical checks apply even when branch protection is not configured.",
    );
  });

  test("findings become verified repairs within authority, not fabricated approval", () => {
    expect(policy).toContain("fixing it,");
    expect(policy).toContain("regression coverage");
    expect(policy).toContain("unless fixes are also");
    expect(policy).toContain("Do not manufacture approval");
    expect(agents).toContain("Explicit read-only requests remain read-only");
  });
});
