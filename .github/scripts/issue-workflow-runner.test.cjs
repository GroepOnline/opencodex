"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const workflows = path.join(__dirname, "..", "workflows");
const issueAutomation = [
  ["enforce-issue-quality.yml", 3],
  ["issue-triage.yml", 2],
  ["stale-needs-info.yml", 1],
];

describe("lightweight issue automation runner contract", () => {
  for (const [filename, expectedJobs] of issueAutomation) {
    it(`${filename} uses portable hosted runners for every job`, () => {
      const source = fs.readFileSync(path.join(workflows, filename), "utf8");
      const runners = [...source.matchAll(/^    runs-on:\s*(.+)$/gm)].map((m) => m[1].trim());
      assert.equal(runners.length, expectedJobs, "every job must define its runner explicitly");
      assert.deepEqual(runners, Array(expectedJobs).fill("ubuntu-latest"));
      assert.doesNotMatch(source, /^\s*runs-on:\s*\[self-hosted,/m);
    });
  }
});
