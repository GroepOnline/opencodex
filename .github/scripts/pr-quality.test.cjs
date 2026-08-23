"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  ANCESTRY_BEHIND_THRESHOLD,
  isWrongAncestry,
  authorHasPushPermission,
  assessPrDescription,
  collectPrQualityFailures,
} = require("./pr-quality.cjs");

describe("isWrongAncestry", () => {
  it("flags a head far behind the PR base", () => {
    assert.equal(
      isWrongAncestry({ behindMain: 44, behindBase: 44, aheadMain: 1 }),
      true,
    );
  });

  it("uses threshold 20 by default", () => {
    assert.equal(ANCESTRY_BEHIND_THRESHOLD, 20);
    assert.equal(isWrongAncestry({ behindMain: 20, behindBase: 20, aheadMain: 1 }), true);
    assert.equal(isWrongAncestry({ behindMain: 19, behindBase: 19, aheadMain: 1 }), false);
  });

  it("passes a head based on the current main tip", () => {
    assert.equal(isWrongAncestry({ behindMain: 0, behindBase: 0, aheadMain: 8 }), false);
  });

  it("flags a stale feature branch even when it is also ahead of main", () => {
    assert.equal(
      isWrongAncestry({ behindMain: 44, behindBase: 44, aheadMain: 50 }),
      true,
    );
  });
});

describe("authorHasPushPermission", () => {
  it("accepts write/maintain/admin only", () => {
    assert.equal(authorHasPushPermission("admin"), true);
    assert.equal(authorHasPushPermission("maintain"), true);
    assert.equal(authorHasPushPermission("write"), true);
    assert.equal(authorHasPushPermission("triage"), false);
    assert.equal(authorHasPushPermission("read"), false);
    assert.equal(authorHasPushPermission(null), false);
  });
});

describe("assessPrDescription", () => {
  it("rejects empty and comment-only bodies", () => {
    assert.equal(assessPrDescription("").ok, false);
    assert.equal(assessPrDescription("   ").ok, false);
    assert.equal(
      assessPrDescription("<!-- release notes by coderabbit.ai -->\n\n<!-- end -->").reason,
      "empty",
    );
  });

  it("rejects placeholder-only bodies", () => {
    assert.equal(assessPrDescription("N/A").reason, "placeholder");
    assert.equal(assessPrDescription("TODO").reason, "placeholder");
  });

  it("rejects literal escaped newlines like #644", () => {
    const body =
      "## What changed\\n- make the Windows tray launcher resolve Codex home\\n\\n## Validation\\n- git diff --check";
    assert.equal(assessPrDescription(body).reason, "escaped_newlines");
  });

  it("rejects thin real-newline bodies", () => {
    assert.equal(assessPrDescription("fix stuff").reason, "thin");
  });

  it("rejects an untouched GitHub PR template as empty/thin", () => {
    const body = [
      "## Summary",
      "",
      "- Explain the user-visible or maintainer-facing change.",
      "",
      "## Verification",
      "",
      "- List the commands or checks you ran.",
      "",
      "## Checklist",
      "",
      "- [ ] Scope stays focused and avoids unrelated cleanup.",
      "- [ ] Docs or release notes were updated when needed.",
      "- [ ] Security-sensitive changes were reviewed for secrets, auth, and unsafe defaults.",
    ].join("\n");
    const result = assessPrDescription(body);
    assert.equal(result.ok, false);
    assert.ok(result.reason === "empty" || result.reason === "thin");
  });

  it("accepts two rich markdown sections", () => {
    const body = [
      "## Summary",
      "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
      "",
      "## Test plan",
      "- Launch the tray app after setting CODEX_HOME",
      "- Confirm the listener and launcher use the same workspace root",
    ].join("\n");
    assert.equal(assessPrDescription(body).ok, true);
  });

  it("accepts unstructured bodies that are long enough with multiple blocks", () => {
    const p1 =
      "Updates the Windows tray launcher to resolve the active Codex home through the shared helper so listener and launcher stay aligned.";
    const p2 =
      "Validated with git diff --check on the changed tray module; typecheck was not available in that session so CI must cover it.";
    assert.equal(assessPrDescription(`${p1}\n\n${p2}`).ok, true);
  });
});

describe("collectPrQualityFailures", () => {
  const allowed = ["main"];

  it("reports wrong_base without requiring ancestry inputs", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      body: "## Summary\n" + "x".repeat(50) + "\n\n## Test plan\n" + "y".repeat(50),
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
    });
    assert.ok(failures.some((f) => f.code === "wrong_base"));
    assert.ok(!failures.some((f) => f.code === "wrong_ancestry"));
  });

  it("reports wrong_base and bad_description together for dev + empty body", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      body: "",
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
    });
    assert.ok(failures.some((f) => f.code === "wrong_base"));
    assert.ok(failures.some((f) => f.code === "bad_description"));
    assert.ok(!failures.some((f) => f.code === "wrong_ancestry"));
  });

  it("reports wrong_ancestry for contributor on a stale main-based head", () => {
    const failures = collectPrQualityFailures({
      baseRef: "main",
      allowedBases: allowed,
      body: [
        "## Summary",
        "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
        "",
        "## Test plan",
        "- Launch the tray app after setting CODEX_HOME",
        "- Confirm the listener and launcher use the same workspace root",
      ].join("\n"),
      behindMain: 44,
      behindBase: 44,
      aheadMain: 1,
      authorPermission: "read",
    });
    assert.deepEqual(
      failures.map((f) => f.code),
      ["wrong_ancestry"],
    );
  });

  it("skips ancestry for push permission but still flags bad description", () => {
    const failures = collectPrQualityFailures({
      baseRef: "main",
      allowedBases: allowed,
      body: "",
      behindMain: 44,
      behindBase: 44,
      aheadMain: 1,
      authorPermission: "write",
    });
    assert.ok(!failures.some((f) => f.code === "wrong_ancestry"));
    assert.ok(failures.some((f) => f.code === "bad_description"));
  });

  it("applies ancestry when permission lookup failed (fail closed)", () => {
    const failures = collectPrQualityFailures({
      baseRef: "main",
      allowedBases: allowed,
      body: [
        "## Summary",
        "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
        "",
        "## Test plan",
        "- Launch the tray app after setting CODEX_HOME",
        "- Confirm the listener and launcher use the same workspace root",
      ].join("\n"),
      behindMain: 44,
      behindBase: 44,
      aheadMain: 1,
      authorPermission: null,
      permissionLookupFailed: true,
    });
    assert.ok(failures.some((f) => f.code === "wrong_ancestry"));
  });

  it("flags a stale head even when it is also far ahead of main", () => {
    const failures = collectPrQualityFailures({
      baseRef: "main",
      allowedBases: allowed,
      body: [
        "## Summary",
        "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
        "",
        "## Test plan",
        "- Launch the tray app after setting CODEX_HOME",
        "- Confirm the listener and launcher use the same workspace root",
      ].join("\n"),
      behindMain: 44,
      behindBase: 44,
      aheadMain: 50,
      authorPermission: "read",
    });
    assert.ok(failures.some((f) => f.code === "wrong_ancestry"));
  });

  it("skips ancestry when compare lookup failed (cannot evaluate)", () => {
    const failures = collectPrQualityFailures({
      baseRef: "main",
      allowedBases: allowed,
      body: [
        "## Summary",
        "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
        "",
        "## Test plan",
        "- Launch the tray app after setting CODEX_HOME",
        "- Confirm the listener and launcher use the same workspace root",
      ].join("\n"),
      behindMain: 0,
      behindBase: 0,
      aheadMain: 0,
      authorPermission: "read",
      ancestryLookupFailed: true,
    });
    assert.ok(!failures.some((f) => f.code === "wrong_ancestry"));
  });

  it("skips wrong_base when stackedBase is set", () => {
    const failures = collectPrQualityFailures({
      baseRef: "feature/parent",
      allowedBases: allowed,
      body: [
        "## Summary",
        "This change updates the Windows tray launcher so it resolves CODEX_HOME through the shared helper instead of a hardcoded path.",
        "",
        "## Test plan",
        "- Launch the tray app after setting CODEX_HOME",
        "- Confirm the listener and launcher use the same workspace root",
      ].join("\n"),
      behindMain: 0,
      behindBase: 44,
      aheadMain: 1,
      authorPermission: "read",
      stackedBase: true,
    });
    assert.ok(!failures.some((f) => f.code === "wrong_base"));
    assert.ok(!failures.some((f) => f.code === "wrong_ancestry"));
  });

  it("still flags wrong_base for non-allow-list bases without stackedBase", () => {
    const failures = collectPrQualityFailures({
      baseRef: "dev",
      allowedBases: allowed,
      body: "fix stuff",
      behindMain: 0,
      behindBase: 0,
      authorPermission: "read",
      stackedBase: false,
    });
    assert.ok(failures.some((f) => f.code === "wrong_base"));
  });
});
