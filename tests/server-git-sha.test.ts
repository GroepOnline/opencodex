import { describe, expect, test } from "bun:test";
import { readPackagedGitSha, resolveGitSha } from "../src/server/git-sha";

describe("server git SHA provenance", () => {
  test("prefers the explicit runtime override", () => {
    expect(
      resolveGitSha(
        { OPENCODEX_GIT_SHA: " env-sha " },
        () => "git-sha",
        () => "packaged-sha",
      ),
    ).toBe("env-sha");
  });

  test("falls back from git metadata to the packaged release build info", () => {
    expect(
      resolveGitSha(
        {},
        () => "git-sha",
        () => "packaged-sha",
      ),
    ).toBe("git-sha");
    expect(
      resolveGitSha(
        {},
        () => null,
        () => "packaged-sha",
      ),
    ).toBe("packaged-sha");
    expect(
      resolveGitSha(
        {},
        () => null,
        () => null,
      ),
    ).toBeNull();
  });

  test("reads a valid SHA from build-info.json for npm installs without .git", () => {
    expect(readPackagedGitSha()).toMatch(/^[0-9a-f]{7,64}$/i);
  });
});
