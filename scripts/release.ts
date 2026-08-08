#!/usr/bin/env bun
/**
 * Release helper (jawcode-style, single package). Not shipped in the npm tarball.
 *
 * Usage:
 *   bun scripts/release.ts [<version>|--minor|--major] [--tag latest|preview] [--publish]
 *       Without a version, the current package.json version is bumped (patch by
 *       default; --minor/--major for bigger bumps; a -preview.N version bumps its
 *       preview number). Preflight (clean tree + typecheck + tests + privacy scan)
 *       → bump package.json → commit → push → wait for Cross-platform CI → dispatch
 *       the Release workflow → watch it.
 *       Optional --linear GRO-123/CHE-123 links the release commit to Linear.
 *       The version bump commit/push is real; the Release workflow publish step is dry-run by default.
 *       Pass --publish to publish.
 *   bun scripts/release.ts watch
 *       Watch the most recent Release run.
 *
 * Example:  bun scripts/release.ts              # auto-bump patch (1.0.0 → 1.0.1)
 *           bun scripts/release.ts --minor      # auto-bump minor (1.0.0 → 1.1.0)
 *           bun scripts/release.ts 0.1.0 --publish  # explicit version, actually publish 0.1.0
 *           bun scripts/release.ts 1.0.1 --linear GRO-994 # link release evidence to Linear
 *
 * Requires: gh CLI (authed). Publishing is tokenless via Trusted Publishing (OIDC) — no NPM_TOKEN.
 */
import { $ } from "bun";

const args = process.argv.slice(2);
interface GhRun {
  conclusion: string | null;
  createdAt?: string;
  databaseId: number;
  headSha: string;
  status: string;
  url: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const CI_WORKFLOW = "ci.yml";
const SERVICE_WORKFLOW = "service-lifecycle.yml";
const CI_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const CI_POLL_MS = 10 * 1000;

async function runQuiet(command: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function readPackageName(): Promise<string> {
  try {
    const pkg = JSON.parse(await Bun.file("package.json").text()) as { name?: unknown };
    if (typeof pkg.name !== "string" || !pkg.name) {
      console.error("✗ package.json is missing a valid name");
      process.exit(1);
    }
    return pkg.name;
  } catch (error) {
    console.error(`✗ failed to read package.json: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function readPackageVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await Bun.file("package.json").text()) as { version?: unknown };
    if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version)) {
      console.error(`✗ package.json is missing a valid version (got ${JSON.stringify(pkg.version)})`);
      process.exit(1);
    }
    return pkg.version;
  } catch (error) {
    console.error(`✗ failed to read package.json: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/** Bump a version. A prerelease (X.Y.Z-preview.N) bumps its preview number; a
 *  stable version bumps the requested segment and drops any prerelease suffix. */
function bumpVersion(current: string, bump: "patch" | "minor" | "major"): string {
  const previewMatch = current.match(/^(\d+)\.(\d+)\.(\d+)-preview\.(\d+)$/);
  if (previewMatch) {
    return `${previewMatch[1]}.${previewMatch[2]}.${previewMatch[3]}-preview.${Number(previewMatch[4]) + 1}`;
  }
  const [major, minor, patch] = current.split("-")[0]!.split(".").map(Number);
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

async function npmVersionExists(packageName: string, version: string): Promise<boolean> {
  const result = await runQuiet(["npm", "view", `${packageName}@${version}`, "version"]);
  if (result.exitCode === 0) return true;

  const output = `${result.stdout}\n${result.stderr}`;
  if (output.includes("E404") || output.includes("No match found")) return false;

  console.error(`✗ failed to check npm version ${packageName}@${version}`);
  if (result.stderr) console.error(result.stderr);
  process.exit(1);
}

async function remoteTagSha(tagName: string): Promise<string | null> {
  const result = await runQuiet(["git", "ls-remote", "origin", `refs/tags/${tagName}`, `refs/tags/${tagName}^{}`]);
  if (result.exitCode !== 0) {
    console.error(`✗ failed to check remote tag ${tagName}`);
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }

  const lines = result.stdout.split("\n").filter(Boolean);
  const peeled = lines.find(line => line.endsWith(`refs/tags/${tagName}^{}`));
  const exact = lines.find(line => line.endsWith(`refs/tags/${tagName}`));
  const selected = peeled ?? exact;
  return selected ? selected.split(/\s+/)[0] ?? null : null;
}

async function githubReleaseExists(tagName: string): Promise<boolean> {
  const result = await runQuiet(["gh", "release", "view", tagName, "--json", "tagName"]);
  if (result.exitCode === 0) return true;

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (output.includes("release not found") || output.includes("not found")) return false;

  console.error(`✗ failed to check GitHub Release ${tagName}`);
  if (result.stderr) console.error(result.stderr);
  process.exit(1);
}

async function assertUnusedReleaseVersion(packageName: string, version: string): Promise<void> {
  const releaseTag = `v${version}`;
  const [npmUsed, tagSha, releaseUsed] = await Promise.all([
    npmVersionExists(packageName, version),
    remoteTagSha(releaseTag),
    githubReleaseExists(releaseTag),
  ]);

  const failures: string[] = [];
  if (npmUsed) failures.push(`- npm already has ${packageName}@${version}`);
  if (tagSha) failures.push(`- remote Git tag ${releaseTag} already exists at ${tagSha}`);
  if (releaseUsed) failures.push(`- GitHub Release ${releaseTag} already exists`);

  if (failures.length > 0) {
    console.error(`✗ release version ${version} is already partially or fully used:`);
    console.error(failures.join("\n"));
    console.error("Choose the next unused patch version, or make an explicit human decision to repair public metadata.");
    process.exit(1);
  }
}

async function watchLatest(): Promise<void> {
  const id = (await $`gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId'`.text()).trim();
  if (!id) { console.error("No Release runs found yet."); process.exit(1); }
  await watchRun(id);
}

async function watchRun(id: string | number): Promise<void> {
  console.log(`→ watching Release run ${id}`);
  await $`gh run watch ${String(id)} --exit-status --interval 10`;
}

async function waitForReleaseWorkflowRun(sha: string, branch: string, createdAfterIso: string): Promise<GhRun> {
  const deadline = Date.now() + 2 * 60 * 1000;
  let attempt = 1;
  while (Date.now() < deadline) {
    const raw = await $`gh run list --workflow release.yml --branch ${branch} --commit ${sha} --limit 20 --json createdAt,databaseId,headSha,status,url`.text();
    const runs = (JSON.parse(raw) as GhRun[])
      .filter(run => run.headSha === sha)
      .filter(run => !run.createdAt || run.createdAt >= createdAfterIso)
      .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    const run = runs[0];
    if (run) {
      console.log(`→ Release workflow run found: ${run.url}`);
      return run;
    }
    console.log(`→ waiting for dispatched Release run (${sha.slice(0, 7)}) attempt ${attempt}`);
    attempt += 1;
    await Bun.sleep(5_000);
  }
  console.error(`✗ timed out waiting for dispatched Release workflow run on ${sha}`);
  process.exit(1);
}

async function listCiRuns(sha: string, workflow: string = CI_WORKFLOW): Promise<GhRun[]> {
  const raw = await $`gh run list --workflow ${workflow} --commit ${sha} --limit 20 --json conclusion,databaseId,headSha,status,url`.text();
  const runs = JSON.parse(raw) as GhRun[];
  return runs.filter(run => run.headSha === sha);
}

async function waitForSuccessfulCi(sha: string, workflow: string = CI_WORKFLOW, label = "Cross-platform CI"): Promise<GhRun> {
  const deadline = Date.now() + CI_WAIT_TIMEOUT_MS;
  let attempt = 1;
  while (Date.now() < deadline) {
    const runs = await listCiRuns(sha, workflow);
    const successful = runs.find(run => run.status === "completed" && run.conclusion === "success");
    if (successful) {
      console.log(`→ ${label} passed: ${successful.url}`);
      return successful;
    }

    const failed = runs.find(run => run.status === "completed" && run.conclusion && run.conclusion !== "success");
    if (failed) {
      console.error(`✗ ${label} failed for ${sha}: ${failed.url}`);
      process.exit(1);
    }

    const state = runs.length > 0
      ? runs.map(run => `${run.status}${run.conclusion ? `/${run.conclusion}` : ""}`).join(", ")
      : "not started yet";
    console.log(`→ waiting for ${label} (${sha.slice(0, 7)}) attempt ${attempt}: ${state}`);
    attempt += 1;
    await Bun.sleep(CI_POLL_MS);
  }

  console.error(`✗ timed out waiting for ${label} on ${sha}`);
  process.exit(1);
}

async function _remoteMainSha(): Promise<string> {
  const out = (await $`git ls-remote origin refs/heads/main`.text()).trim();
  const [sha] = out.split(/\s+/);
  if (!sha) {
    console.error("✗ could not resolve origin/main");
    process.exit(1);
  }
  return sha;
}

/** Live (network) head of a remote branch — never the local remote-tracking ref. */
async function remoteBranchHead(branch: string): Promise<string> {
  const out = (await $`git ls-remote origin refs/heads/${branch}`.text()).trim();
  const [sha] = out.split(/\s+/);
  if (!sha) {
    console.error(`✗ could not resolve origin/${branch}`);
    process.exit(1);
  }
  return sha;
}

if (args[0] === "watch") {
  await watchLatest();
  process.exit(0);
}

const explicitVersion = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
if (explicitVersion && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(explicitVersion)) {
  console.error(`Invalid version: ${explicitVersion}`);
  process.exit(1);
}
let version = explicitVersion;
const dryRun = !args.includes("--publish");

if (!version) {
  const bump = args.includes("--minor") ? "minor" : args.includes("--major") ? "major" : "patch";
  const current = await readPackageVersion();
  version = bumpVersion(current, bump);
  console.log(`→ no explicit version: bumping ${bump} → ${version}`);
}
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("Usage: bun scripts/release.ts [<version>|--minor|--major] [--linear GRO-123] [--tag latest|preview] [--publish]\n       bun scripts/release.ts watch");
  process.exit(1);
}
const linearFlagIndex = args.indexOf("--linear");
const linearIssue = linearFlagIndex === -1 ? undefined : args[linearFlagIndex + 1];
if (linearFlagIndex !== -1 && (!linearIssue || !/^(?:GRO|CHE)-\d+$/.test(linearIssue))) {
  console.error("Linear issue must use a GRO-123 or CHE-123 identifier.");
  process.exit(1);
}

// 1. Preflight — every release runs from main (release.yml rejects any other ref),
// and local verification must pass. Stable versions publish to the `latest` dist-tag,
// prereleases to `preview`; the only supported prerelease shape is X.Y.Z-preview.N,
// which is what the update client and the release-notes helper recognize.
const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
const releaseBranch = "main";
const isPrerelease = version.includes("-");
const expectedTag = isPrerelease ? "preview" : "latest";
const tag = args.includes("--tag") ? (args[args.indexOf("--tag") + 1] ?? expectedTag) : expectedTag;
if (tag !== expectedTag) {
  const kind = isPrerelease ? "Pre-release" : "Stable";
  console.error(`Release tag mismatch: ${kind} versions must use npm dist-tag '${expectedTag}' (got '${tag}').`);
  process.exit(1);
}
if (isPrerelease && !/^\d+\.\d+\.\d+-preview\.\d+$/.test(version)) {
  console.error(`Pre-release versions must be X.Y.Z-preview.N (got ${version}).`);
  process.exit(1);
}
if (branch !== releaseBranch) { console.error(`✗ must be on ${releaseBranch} (currently ${branch}).`); process.exit(1); }
if ((await $`git status --porcelain`.text()).trim()) { console.error("✗ working tree not clean — commit or stash first."); process.exit(1); }
const packageName = await readPackageName();
console.log(`→ release metadata preflight (${packageName}@${version})`);
await assertUnusedReleaseVersion(packageName, version);
console.log("→ typecheck");
await $`bun x tsc --noEmit`;
console.log("→ test suite");
await $`bun test --isolate tests`;
console.log("→ privacy scan");
await $`bun run privacy:scan`;

// 2. Bump package.json only; the workflow creates the version tag after npm publish.
console.log(`→ bump package.json → ${version}`);
await $`npm version ${version} --no-git-tag-version`;

// 3. Commit + push the version bump.
await $`git add package.json`;
const releaseCommitMessage = `release: v${version}${linearIssue ? ` (${linearIssue})` : ""}`;
await $`git commit -m ${releaseCommitMessage}`;
const releaseSha = (await $`git rev-parse HEAD`.text()).trim();
console.log(`→ push origin ${branch}`);
await $`git push origin ${branch}`;

// 4. Wait for the pushed release commit to pass CI, then dispatch the Release workflow.
console.log(`→ wait for Cross-platform CI (${releaseSha})`);
await waitForSuccessfulCi(releaseSha);

// The release bump always touches package.json, which is a service-lifecycle trigger path —
// and release.yml's service gate requires an already-successful Service lifecycle run for
// the release SHA. Wait for it too, or the dispatch races the still-running workflow.
console.log(`→ wait for Service lifecycle (${releaseSha})`);
await waitForSuccessfulCi(releaseSha, SERVICE_WORKFLOW, "Service lifecycle");

// Live-remote guard: re-read the actual remote head over the network immediately
// before dispatch. The local remote-tracking ref can be minutes stale, and the
// workflow_dispatch below resolves a mutable branch — so this is the last chance
// to refuse publishing an unaudited newer commit.
const liveOriginSha = await remoteBranchHead(branch);
if (liveOriginSha !== releaseSha) {
  console.error(`✗ origin/${branch} moved while waiting for CI (${liveOriginSha} != ${releaseSha}); aborting release dispatch.`);
  process.exit(1);
}

console.log(`→ dispatch Release (tag=${tag}, dry-run=${dryRun})`);
const dispatchStartedAt = new Date(Date.now() - 5_000).toISOString();
await $`gh workflow run release.yml --ref ${branch} -f version=${version} -f tag=${tag} -f expected-sha=${releaseSha} -f dry-run=${String(dryRun)}`;

// 5. Watch it.
const releaseRun = await waitForReleaseWorkflowRun(releaseSha, branch, dispatchStartedAt);
await watchRun(releaseRun.databaseId);
console.log(dryRun
  ? "\n✓ Dry run complete. Re-run with --publish to publish for real."
  : "\n✓ Published. Try:  npm install -g @groeponline/opencodex");
