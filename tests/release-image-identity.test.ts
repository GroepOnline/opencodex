import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

type WorkflowStep = { name: string; run?: string };
type Workflow = {
  jobs: Record<string, { if?: string; steps: WorkflowStep[] }>;
};

function workflow(name: string): Workflow {
  return Bun.YAML.parse(
    readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  ) as Workflow;
}

const container = workflow("container");
const release = workflow("release");

function script(source: Workflow, job: string, name: string): string {
  const step = source.jobs[job]!.steps.find(
    (candidate) => candidate.name === name,
  );
  if (!step?.run) throw new Error(`Missing workflow script: ${job}/${name}`);
  return step.run;
}

const recordDigest = script(container, "publish", "Record digest");
const verifyIdentity = script(
  release,
  "rollout",
  "Verify release image identity",
);
const requireCredentials = script(
  release,
  "production-dispatch",
  "Require deployment app credentials",
);
const dispatch = script(
  release,
  "production-dispatch",
  "Dispatch private production deployment",
);
const releaseTag = "v1.5.6";
const sourceSha = "a".repeat(40);
const imageRunId = "1234567890";
const imageDigest = `sha256:${"b".repeat(64)}`;
const identity = {
  schemaVersion: 1,
  releaseTag,
  sourceSha,
  imageDigest,
  imageRunId,
};
const bash = Bun.which("bash");
const python = Bun.which("python3");

describe("production dispatch gate", () => {
  test.each([
    ["false", "latest", "1.5.6", true],
    ["true", "latest", "1.5.6", false],
    ["false", "preview", "1.5.6", false],
    ["false", "latest", "1.5.6-preview.1", false],
    ["false", "preview", "1.5.6-preview.1", false],
    ["true", "preview", "1.5.6-preview.1", false],
  ] as const)(
    "dry-run=%s channel=%s version=%s allows dispatch=%s",
    (dryRun, tag, version, allowed) => {
      // Evaluate the actual condition, translating only the Actions hyphenated property.
      const condition = release.jobs["production-dispatch"]!.if!.replace(
        "github.event.inputs.dry-run",
        'github.event.inputs["dry-run"]',
      );
      expect(
        runInNewContext(
          condition,
          {
            github: { event: { inputs: { "dry-run": dryRun } } },
            inputs: { tag, version },
            contains: (value: string, search: string) =>
              value.toLowerCase().includes(search.toLowerCase()),
          },
          { timeout: 1000 },
        ),
      ).toBe(allowed);
    },
  );
});

// These are scripts for an Ubuntu Actions runner; never substitute a real gh executable.
describe.skipIf(!bash || !python)("release image scripts", () => {
  let directory: string;
  let output: string;
  let summary: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ocx-release-image-"));
    output = join(directory, "github-output");
    summary = join(directory, "github-summary");
    writeFileSync(output, "");
    writeFileSync(summary, "");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function run(source: string, env: Record<string, string> = {}) {
    const result = spawnSync(bash!, ["--noprofile", "--norc", "-c", source], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        RELEASE_TAG: releaseTag,
        SOURCE_SHA: sourceSha,
        IMAGE_RUN_ID: imageRunId,
        ...env,
      },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return result;
  }

  function writeIdentity(record: unknown) {
    mkdirSync(join(directory, "release-image"), { recursive: true });
    writeFileSync(
      join(directory, "release-image", "release-image.json"),
      JSON.stringify(record),
    );
  }

  function publish(env: Record<string, string> = {}) {
    return run(recordDigest, {
      PUSH: "true",
      DIGEST: imageDigest,
      IMAGE_ID: "synthetic-image-id",
      IMAGE: "ghcr.io/groeponline/opencodex",
      VERSION: "1.5.6",
      GITHUB_REF: `refs/tags/${releaseTag}`,
      ...env,
    });
  }

  test("published artifact round-trips into the exact verified output", () => {
    expect(publish().status).toBe(0);
    const artifact = readFileSync(
      join(directory, "release-image.json"),
      "utf8",
    );
    expect(JSON.parse(artifact)).toEqual(identity);
    expect(artifact.endsWith("\n")).toBe(true);
    writeIdentity(JSON.parse(artifact));
    // Writing to GITHUB_OUTPUT must append rather than erase earlier step outputs.
    writeFileSync(output, "previous_output=preserved\n");
    expect(run(verifyIdentity).status).toBe(0);
    // Git Bash can append CRLF to GITHUB_OUTPUT on Windows; compare logical output lines.\n    expect(readFileSync(output, "utf8").replace(/\r\n/g, "\n")).toBe(
      `previous_output=preserved\nimage_digest=${imageDigest}\n`,
    );
  });

  test.each(["refs/heads/main", "refs/pull/370/merge"])(
    "non-release ref %s emits no release artifact",
    (ref) => {
      expect(
        publish({ GITHUB_REF: ref, PUSH: "false", DIGEST: "" }).status,
      ).toBe(0);
      expect(existsSync(join(directory, "release-image.json"))).toBe(false);
    },
  );

  test.each([
    "",
    "latest",
    `sha256:${"b".repeat(63)}`,
    `sha256:${"B".repeat(64)}`,
    `${imageDigest}\n`,
  ])(
    "publishing refuses invalid digest %j before emitting an artifact",
    (digest) => {
      const result = publish({ DIGEST: digest });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        "GHCR publish returned no immutable sha256 digest",
      );
      expect(existsSync(join(directory, "release-image.json"))).toBe(false);
      expect(readFileSync(summary, "utf8")).toBe("");
    },
  );

  test.each([
    ["schemaVersion", 2],
    ["schemaVersion", "1"],
    ["releaseTag", "v1.5.5"],
    ["sourceSha", "c".repeat(40)],
    ["sourceSha", sourceSha.slice(0, 7)],
    ["imageRunId", "1234567891"],
    ["imageRunId", 1234567890],
  ] as const)(
    "rejects mismatched %s=%j without exposing a deployment output",
    (key, value) => {
      writeIdentity({ ...identity, [key]: value });
      const result = run(verifyIdentity);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `release-image ${key} mismatch; refusing deployment dispatch`,
      );
      expect(readFileSync(output, "utf8")).toBe("");
    },
  );

  test.each(Object.keys(identity))(
    "missing identity field %s fails closed",
    (key) => {
      const record: Record<string, unknown> = { ...identity };
      delete record[key];
      writeIdentity(record);
      expect(run(verifyIdentity).status).toBe(1);
      expect(readFileSync(output, "utf8")).toBe("");
    },
  );

  test.each([
    null,
    123,
    {},
    "",
    "sha256:",
    `sha256:${"b".repeat(63)}`,
    `sha256:${"b".repeat(65)}`,
    `sha256:${"B".repeat(64)}`,
    `sha256:${"g".repeat(64)}`,
    `sha512:${"b".repeat(64)}`,
    ` ${imageDigest}`,
    `${imageDigest}\n`,
    `${imageDigest}\nimage_digest=other`,
  ])("rejects malformed digest %j", (digest) => {
    writeIdentity({ ...identity, imageDigest: digest });
    const result = run(verifyIdentity);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "release-image digest is missing or invalid",
    );
    expect(readFileSync(output, "utf8")).toBe("");
  });

  test.each(["missing", "invalid JSON", "null", "array"])(
    "unreadable artifact (%s) produces no verified output",
    (kind) => {
      if (kind !== "missing") {
        writeIdentity(kind === "null" ? null : []);
        if (kind === "invalid JSON")
          writeFileSync(
            join(directory, "release-image", "release-image.json"),
            "{",
          );
      }
      const result = run(verifyIdentity);
      expect(result.status).not.toBe(0);
      expect(readFileSync(output, "utf8")).toBe("");
    },
  );

  test.each([
    ["", "", 1],
    ["synthetic-app-id", "", 1],
    ["", "synthetic-private-key", 1],
    ["synthetic-app-id", "synthetic-private-key", 0],
  ] as const)(
    "deployment credentials require both values (%j, %j)",
    (appId, privateKey, status) => {
      const result = run(requireCredentials, {
        APP_ID: appId,
        APP_PRIVATE_KEY: privateKey,
      });
      expect(result.status).toBe(status);
      expect(result.stdout + result.stderr).not.toContain(
        "synthetic-private-key",
      );
      expect(readFileSync(summary, "utf8")).toBe("");
    },
  );

  test.each([0, 1])(
    "dispatch status %i is acknowledged only on acceptance",
    (status) => {
      // An in-process shell function captures argv; no GitHub request or token is used.
      const stub =
        'gh() { printf "%s\\0" "$@" > "$DISPATCH_ARGS"; return "$DISPATCH_STATUS"; }\n';
      const argsFile = join(directory, "dispatch-args");
      const result = run(stub + dispatch, {
        IMAGE_DIGEST: imageDigest,
        NPM_RUN_ID: "9876543210",
        DISPATCH_ARGS: argsFile,
        DISPATCH_STATUS: String(status),
      });
      expect(result.status).toBe(status);
      expect(
        readFileSync(argsFile, "utf8").split("\0").filter(Boolean),
      ).toEqual([
        "workflow",
        "run",
        "ocx-container-deploy.yml",
        "--repo",
        "GroepOnline/ChefFactory",
        "--ref",
        "main",
        "-f",
        `release_tag=${releaseTag}`,
        "-f",
        `source_sha=${sourceSha}`,
        "-f",
        `image_digest=${imageDigest}`,
        "-f",
        "npm_run_id=9876543210",
        "-f",
        `image_run_id=${imageRunId}`,
      ]);
      const acknowledgement = readFileSync(summary, "utf8");
      if (status === 0) {
        expect(acknowledgement).toContain(
          "deployment is not proven by this acknowledgement",
        );
        for (const value of [
          releaseTag,
          sourceSha,
          imageDigest,
          imageRunId,
          "9876543210",
        ]) {
          expect(acknowledgement).toContain(value);
        }
      } else {
        expect(acknowledgement).toBe("");
      }
    },
  );
});
