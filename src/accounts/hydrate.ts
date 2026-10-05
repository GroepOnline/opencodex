/**
 * Load account-runtime.json into the existing in-memory Maps/Sets
 * (cooldown, AUTH_FAILED, pool RR cursor). Not a router: routing still
 * uses those Maps as the hot path.
 */
import { hydrateAccountNeedsReauth } from "../codex/account-runtime-state";
import { hydratePoolRotation } from "../codex/pool-rotation";
import { hydrateCodexAccountHealth } from "../codex/routing";
import { hydrateAnthropicAccountHealth } from "../oauth/anthropic-routing";
import { hydrateCursorAccountHealth } from "../oauth/cursor-routing";
import { hydrateGoogleAntigravityAccountHealth } from "../oauth/google-antigravity-routing";
import { hydrateKeyCooldown } from "../providers/key-failover";
import {
  isActiveRuntime,
  listAccountRuntimes,
  listPoolRotationCursors,
  parseKeyRuntimeProvider,
  reloadAccountRuntimeStore,
  type AccountRuntime,
} from "./runtime";

function cooldownSourceFor(record: AccountRuntime): "retry-after" | "default" {
  return record.state === "RATE_LIMITED" || record.reason === "retry_after"
    ? "retry-after"
    : "default";
}

function applyRecord(record: AccountRuntime, now: number): void {
  if (!isActiveRuntime(record, now)) return;
  const keyProvider = parseKeyRuntimeProvider(record.provider);
  if (keyProvider) {
    if (typeof record.until === "number") hydrateKeyCooldown(keyProvider, record.accountId, record.until);
    return;
  }
  if (record.state === "AUTH_FAILED") {
    if (record.provider === "codex") hydrateAccountNeedsReauth(record.accountId);
    return;
  }
  if (record.state !== "RATE_LIMITED" && record.state !== "COOLDOWN") return;
  if (typeof record.until !== "number") return;
  const health = {
    cooldownUntil: record.until,
    cooldownSource: cooldownSourceFor(record),
  };
  if (record.provider === "google-antigravity") {
    hydrateGoogleAntigravityAccountHealth(record.accountId, health);
    return;
  }
  if (record.provider === "anthropic") {
    hydrateAnthropicAccountHealth(record.accountId, health);
    return;
  }
  if (record.provider === "cursor") {
    hydrateCursorAccountHealth(record.accountId, health);
    return;
  }
  if (record.provider === "codex") {
    hydrateCodexAccountHealth(record.accountId, {
      cooldownUntil: record.until,
      cooldownSource: record.reason === "quota_window" ? "reset-derived" : cooldownSourceFor(record),
    });
  }
}

export function hydrateAccountRuntimeFromDisk(now = Date.now()): AccountRuntime[] {
  reloadAccountRuntimeStore();
  const records = listAccountRuntimes(now);
  for (const record of records) applyRecord(record, now);
  for (const [poolKey, cursor] of Object.entries(listPoolRotationCursors())) {
    hydratePoolRotation(poolKey, cursor);
  }
  return records;
}
