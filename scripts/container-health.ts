const host = process.env.OPENCODEX_HEALTH_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.OPENCODEX_HEALTH_PORT || "10100");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 4_000);

try {
  const response = await fetch(`http://${host}:${port}/healthz`, {
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`health status ${response.status}`);
  const body = (await response.json()) as {
    status?: unknown;
    service?: unknown;
    pid?: unknown;
    port?: unknown;
    gitSha?: unknown;
  };
  if (body.status !== "ok" || body.service !== "opencodex") {
    throw new Error("health identity mismatch");
  }
  if (
    typeof body.pid !== "number" ||
    body.pid < 1 ||
    typeof body.port !== "number"
  ) {
    throw new Error("health process identity missing");
  }
  // Images omit .git; /healthz.gitSha is whatever the process published (often OPENCODEX_GIT_SHA).
  if (typeof body.gitSha !== "string" || body.gitSha.length === 0) {
    throw new Error("health gitSha missing");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  clearTimeout(timer);
}
