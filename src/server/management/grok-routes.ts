import { saveConfigPreservingClaudeCode } from "../../config";
import { jsonResponse } from "../auth-cors";
import { fetchGrokCandidateModels } from "./shared";
import type { ManagementContext } from "./context";

let grokApplyChain: Promise<unknown> = Promise.resolve();
/**
 * Serializes Grok applies: injectGrokConfig is read-modify-write over a single file,
 * so two concurrent clicks must not interleave two cycles.
 */
function queueGrokApply<T>(run: () => Promise<T>): Promise<T> {
  const next = grokApplyChain.then(run, run);
  grokApplyChain = next.catch(() => {});
  return next;
}
export async function handleGrokRoutes(
  ctx: ManagementContext,
): Promise<Response | null> {
  const { req, url, config } = ctx;

  // Grok Build: view of the managed fence in ~/.grok/config.toml plus the candidate
  // catalog and the user's selection. The fence itself is still written ONLY by
  // injectGrokConfig — the write routes below carry no path/host/port/body input.
  if (url.pathname === "/api/grok" && req.method === "GET") {
    try {
      const { readGrokStatus } = await import("../../grok/status");
      // `candidates` is the full visible catalog the fence WOULD carry, so the page can
      // show a switch for a model the user has already excluded. Aliases come from
      // `status.models` — the writer's output — never computed client-side.
      return jsonResponse({
        ...readGrokStatus(),
        candidates: await fetchGrokCandidateModels(config),
        excluded: config.grokExcludedModels ?? [],
      });
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  }

  // Writes CONFIG only. ~/.grok/config.toml is still written exclusively by
  // injectGrokConfig, through the apply route below — this route cannot touch that file.
  if (url.pathname === "/api/grok/selection" && req.method === "PUT") {
    let body: { excluded?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    const raw = body.excluded;
    if (
      !Array.isArray(raw) ||
      raw.some((entry) => typeof entry !== "string" || entry.length === 0)
    ) {
      return jsonResponse(
        { error: "excluded must be an array of model ids" },
        400,
      );
    }
    // Dedupe + sort so the stored list is stable, and cap it so a hostile client
    // cannot grow config.json without bound.
    const excluded = [...new Set(raw as string[])].sort();
    if (excluded.length > 2000)
      return jsonResponse({ error: "excluded list is too large" }, 400);
    if (excluded.length === 0) delete config.grokExcludedModels;
    else config.grokExcludedModels = excluded;
    saveConfigPreservingClaudeCode(config);
    return jsonResponse({ ok: true, excluded });
  }

  // Re-runs the SAME sync the CLI runs. All guards (no-grok-home, non-loopback refusal,
  // orphaned marker, backup, alias reservation) live in injectGrokConfig and are not
  // duplicated here. Accepts no body: every input comes from persisted state.
  if (url.pathname === "/api/grok/apply" && req.method === "POST") {
    try {
      const { syncGrokConfig } = await import("../../grok/sync");
      const { readRuntimePort } = await import("../../config");
      // The host/port the proxy ACTUALLY bound — not the request authority (caller-
      // influenced) and not config.hostname, which sync.ts warns may have drifted.
      // `ocx ensure` passes live.hostname for the same reason; the runtime-port record
      // is the in-process equivalent, written at startup.
      const runtime = readRuntimePort(process.pid);
      const port = runtime?.port ?? config.port;
      const hostname = runtime?.hostname ?? config.hostname;
      const result = await queueGrokApply(() =>
        syncGrokConfig(
          port,
          config,
          hostname !== undefined ? { hostname } : {},
        ),
      );
      // A policy skip (non-loopback, no ~/.grok) is not a server error: report it as a
      // result the page can explain rather than a 500 the user cannot act on.
      return jsonResponse(
        {
          ok: result.ok,
          changed: result.changed,
          message: result.message,
          ...(result.skippedReason
            ? { skippedReason: result.skippedReason }
            : {}),
        },
        result.ok ? 200 : 500,
      );
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  }

  return null;
}
