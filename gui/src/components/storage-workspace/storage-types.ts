export interface CleanupPreview {
  percent: number;
  count: number;
  bytes: number;
  digest: string;
  candidates: Array<{
    relPath: string;
    bytes: number;
    physicalRelPaths?: string[];
  }>;
}

export interface CleanupResult {
  ok: boolean;
  mode: "quarantine" | "permanent";
  count: number;
  bytes: number;
  trashDir?: string;
  error?: string;
  message?: string;
}

export interface TrashEntry {
  id: string;
  epoch: string;
  fileCount: number;
  bytes: number;
  quarantinedAt?: number;
  mode?: "quarantine" | "permanent";
}

export interface TrashList {
  entries: TrashEntry[];
}

export interface RestoreResult {
  ok: boolean;
  count: number;
  bytes: number;
  trashDir?: string;
  error?: string;
  message?: string;
}

export interface CleanupPolicy {
  enabled: boolean;
  trigger: { archivedBytesOver: number };
  target: { reduceToBytes?: number; removeOldestPercent?: number };
  schedule: "startup" | "daily" | "weekly" | "manual";
  mode: "quarantine" | "permanent";
  lastRun?: { at: number; freedBytes: number; removed: number };
  nextRun?: number;
  job?: {
    status: "idle" | "running";
    reason?: string;
    startedAt?: number;
    finishedAt?: number;
    lastError?: string;
    lastOutcome?: {
      ok: boolean;
      skipped?: string;
      deferred?: string;
      error?: string;
      mode?: string;
      freedBytes?: number;
      removed?: number;
    };
  };
}

export type CachedCleanupPolicy = {
  policy: CleanupPolicy;
  thresholdGb: string;
  targetMode: "percent" | "reduce";
  percent: string;
  reduceGb: string;
};

export type StorageCleanupTab = "policy" | "quarantine";
