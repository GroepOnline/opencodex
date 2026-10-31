import { describe, expect, test } from "bun:test";

const repoRoot = new URL("..", import.meta.url);
const healthCommand = "curl -fsS --max-time 2 http://127.0.0.1:10100/healthz";
const launchCommand = "exec bun run src/cli/index.ts start --port 10100 --proxy-only";

async function mockCloudStart(healthBody: string): Promise<string> {
  const config = (await Bun.file(new URL("../.cursor/environment.json", import.meta.url)).json()) as { start: string };
  expect(config.start).toContain(healthCommand);
  expect(config.start).toContain(launchCommand);
  const script = config.start
    .replace(healthCommand, 'printf "%s" "$OCX_TEST_HEALTH_BODY"')
    .replace(launchCommand, 'printf "BOOTED\\n"');
  const proc = Bun.spawn(["bash", "-c", script], {
    cwd: repoRoot.pathname,
    env: { ...process.env, OCX_TEST_HEALTH_BODY: healthBody },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  return stdout.trim();
}

describe("Cursor Cloud Agent startup identity", () => {
  test("does not start a duplicate when OpenCodex health is valid", async () => {
    expect(await mockCloudStart('{"status":"ok","service":"opencodex"}')).toBe("");
  });

  test("starts when a foreign 200 response contains the old substring", async () => {
    expect(await mockCloudStart('{"status":"ok","service":"other","comment":"\\\"service\\\":\\\"opencodex\\\""}')).toBe("BOOTED");
  });

  test("starts when status is degraded or health is malformed", async () => {
    expect(await mockCloudStart('{"status":"degraded","service":"opencodex"}')).toBe("BOOTED");
    expect(await mockCloudStart('{"status":"ok","service":"opencodex"')).toBe("BOOTED");
  });
});
