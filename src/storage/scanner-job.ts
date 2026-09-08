/**
 * Management wrapper for the synchronous, read-only storage scanner.
 *
 * A complete scan includes recursive metadata reads, largest-file sorting, and
 * immutable SQLite queries. Running the established synchronous implementation
 * in a Worker preserves report parity while keeping those operations off the
 * proxy event loop.
 */
import { resolveCodexHomeDir } from "../codex/home";
import type { StorageReport } from "./scanner";

const WORKER_TIMEOUT_MS = 2 * 60 * 1000;

interface StorageScannerJobTestHooks {
  /** Test-only delay in the worker before it starts scanning. */
  blockMs?: number;
}

let testHooks: StorageScannerJobTestHooks | null = null;
const inflightScans = new Map<string, Promise<StorageReport>>();

export function setStorageScannerJobTestHooks(hooks: StorageScannerJobTestHooks | null): void {
  testHooks = hooks;
}

export function scanStorageForManagement(codexHome: string = resolveCodexHomeDir()): Promise<StorageReport> {
  const existing = inflightScans.get(codexHome);
  if (existing) return existing;
  const scan = runStorageScannerWorker(codexHome);
  inflightScans.set(codexHome, scan);
  void scan.then(() => {
    if (inflightScans.get(codexHome) === scan) inflightScans.delete(codexHome);
  }, () => {
    if (inflightScans.get(codexHome) === scan) inflightScans.delete(codexHome);
  });
  return scan;
}

function runStorageScannerWorker(codexHome: string): Promise<StorageReport> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const worker = new Worker(new URL("./scanner-worker.ts", import.meta.url).href);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { worker.terminate(); } catch { /* worker has already exited */ }
      fn();
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("storage_scan_worker_timeout")));
    }, WORKER_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const message = data as Record<string, unknown>;
      if (message.requestId !== requestId) return;
      if (message.type === "done" && message.report && typeof message.report === "object") {
        finish(() => resolve(message.report as StorageReport));
        return;
      }
      if (message.type === "error") {
        const detail = typeof message.message === "string" ? message.message : "storage_scan_worker_failed";
        finish(() => reject(new Error(detail)));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      finish(() => reject(event.error instanceof Error ? event.error : new Error(event.message || "storage_scan_worker_failed")));
    };
    worker.postMessage({
      type: "scan",
      requestId,
      codexHome,
      ...(typeof testHooks?.blockMs === "number" && testHooks.blockMs > 0 ? { blockMs: testHooks.blockMs } : {}),
    });
  });
}
