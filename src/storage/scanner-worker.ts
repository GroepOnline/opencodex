/**
 * Worker-thread entry for the passive CODEX_HOME storage scan.
 *
 * The scanner intentionally remains synchronous so CLI callers retain its exact
 * snapshot semantics. Management requests run that same scanner here, keeping
 * filesystem walks, sorting, and immutable SQLite reads off the proxy loop.
 */
import { scanStorage } from "./scanner";

interface ScanMessage {
  type: "scan";
  requestId: string;
  codexHome: string;
  /** Test-only synchronous delay used to prove worker isolation at the HTTP boundary. */
  blockMs?: number;
}

function isScanMessage(value: unknown): value is ScanMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return data.type === "scan" && typeof data.requestId === "string" && typeof data.codexHome === "string";
}

declare const self: Worker;

self.onmessage = (event: MessageEvent<unknown>) => {
  if (!isScanMessage(event.data)) return;
  const { requestId, codexHome, blockMs } = event.data;
  try {
    if (typeof blockMs === "number" && Number.isFinite(blockMs) && blockMs > 0) {
      // Atomics.wait blocks this Worker thread rather than merely delaying an
      // async task, so the management regression proves the proxy loop is
      // isolated from real synchronous scan work.
      self.postMessage({ type: "started", requestId });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, Math.floor(blockMs));
    }
    self.postMessage({ type: "done", requestId, report: scanStorage(codexHome) });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : "storage_scan_worker_failed",
    });
  }
};
