import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale, TFn } from "../../i18n/shared";
import { formatBytes } from "../../format-bytes";
import { NumberStepper } from "../NumberStepper";
import { clampNumberDraft } from "../../clamp-draft";
import {
  readSessionListCache,
  writeSessionListCache,
} from "../../session-list-cache";
import {
  draftsFromPolicyResponse,
  GB,
  policyFieldsFromResponse,
  sleep,
} from "./storage-cleanup-policy";
import type { CachedCleanupPolicy, CleanupPolicy } from "./storage-types";

export function AutoCleanupPolicyPanel({
  apiBase,
  locale,
  t,
  onDone,
}: {
  apiBase: string;
  locale: Locale;
  t: TFn;
  onDone: () => void;
}) {
  const cacheKey = `ocx.storage.cleanup-policy.v1:${apiBase}`;
  const cached = readSessionListCache<CachedCleanupPolicy>(cacheKey);
  const hasCacheRef = useRef(Boolean(cached));
  const [policy, setPolicy] = useState<CleanupPolicy | null>(
    () => cached?.policy ?? null,
  );
  const [loading, setLoading] = useState(() => !cached);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetMode, setTargetMode] = useState<"percent" | "reduce">(
    () => cached?.targetMode ?? "percent",
  );
  /** Draft string so blank/invalid percent targets are rejected instead of coerced. */
  const [percent, setPercent] = useState(() => cached?.percent ?? "25");
  /** Draft string so blank/invalid reduce targets are rejected instead of coerced to 0. */
  const [reduceGb, setReduceGb] = useState(() => cached?.reduceGb ?? "4");
  /** Draft string so a cleared threshold is rejected instead of coerced to 0. */
  const [thresholdGb, setThresholdGb] = useState(
    () => cached?.thresholdGb ?? "5",
  );
  /** Cancels in-flight Run-now polling when the panel unmounts. */
  const runAbortRef = useRef<AbortController | null>(null);
  /** User has local draft edits; background GET must not clobber them. */
  const dirtyRef = useRef(false);
  /** True while a draft control is focused. */
  const editingRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const applyPolicy = useCallback(
    (json: CleanupPolicy) => {
      const next = draftsFromPolicyResponse(json);
      setPolicy(next.policy);
      setThresholdGb(next.thresholdGb);
      setTargetMode(next.targetMode);
      setPercent(next.percent);
      setReduceGb(next.reduceGb);
      hasCacheRef.current = true;
      writeSessionListCache(cacheKey, next);
      dirtyRef.current = false;
    },
    [cacheKey],
  );

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  const setEditing = useCallback((editing: boolean) => {
    editingRef.current = editing;
  }, []);

  const loadPolicy = useCallback(
    async (signal?: AbortSignal) => {
      const generation = ++loadGenerationRef.current;
      // Soft refresh: keep last-good policy painted while revalidating.
      if (!hasCacheRef.current) setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${apiBase}/api/storage/cleanup-policy`, {
          signal,
        });
        if (!res.ok) throw new Error("load_failed");
        const json = (await res.json()) as CleanupPolicy;
        if (signal?.aborted || generation !== loadGenerationRef.current) return;
        // Do not overwrite in-progress drafts with a stale/background GET.
        if (dirtyRef.current || editingRef.current) return;
        applyPolicy(json);
      } catch {
        if (signal?.aborted || generation !== loadGenerationRef.current) return;
        if (!hasCacheRef.current) {
          setPolicy(null);
          setError(t("storage.policy.loadFailed"));
        }
      } finally {
        if (!signal?.aborted && generation === loadGenerationRef.current)
          setLoading(false);
      }
    },
    [apiBase, applyPolicy, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void loadPolicy(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      loadGenerationRef.current += 1;
      controller.abort();
    };
  }, [loadPolicy]);

  useEffect(() => {
    return () => {
      runAbortRef.current?.abort();
      runAbortRef.current = null;
    };
  }, []);

  const buildBody = (): CleanupPolicy | null => {
    if (!policy) return null;
    const thresholdRaw = thresholdGb.trim();
    if (thresholdRaw === "") return null;
    const threshold = Number(thresholdRaw);
    if (!Number.isFinite(threshold) || threshold < 0) return null;

    let target: CleanupPolicy["target"];
    if (targetMode === "reduce") {
      const raw = reduceGb.trim();
      if (raw === "") return null;
      const reduce = Number(raw);
      if (!Number.isFinite(reduce) || reduce < 0) return null;
      target = { reduceToBytes: Math.floor(reduce * GB) };
    } else {
      const pct = Number(percent);
      if (!Number.isFinite(pct) || pct < 1 || pct > 100) return null;
      target = {
        removeOldestPercent: Math.min(100, Math.max(1, Math.floor(pct))),
      };
    }

    return {
      enabled: policy.enabled,
      trigger: { archivedBytesOver: Math.floor(threshold * GB) },
      target,
      schedule: policy.schedule,
      mode: policy.mode,
    };
  };

  const savePolicy = async (patch?: Partial<CleanupPolicy>) => {
    const base = buildBody();
    if (!base) {
      setError(t("storage.policy.invalid"));
      return;
    }
    const body = { ...base, ...patch };
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/cleanup-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(t("storage.policy.saveFailed"));
        return;
      }
      const json = (await res.json()) as {
        ok?: boolean;
        policy?: CleanupPolicy;
        error?: string;
      };
      if (!json.policy) {
        setError(t("storage.policy.saveFailed"));
        return;
      }
      applyPolicy(json.policy);
      setStatus(t("storage.policy.saved"));
    } catch {
      setError(t("storage.policy.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    runAbortRef.current?.abort();
    const controller = new AbortController();
    runAbortRef.current = controller;
    const { signal } = controller;

    setRunning(true);
    setError(null);
    setStatus(null);
    try {
      const base = buildBody();
      if (!base) {
        setError(t("storage.policy.invalid"));
        return;
      }
      // Persist current drafts only — never flip enabled:true; Run now must not opt
      // the user into recurring cleanup. A disabled policy still starts the job and
      // reports skippedDisabled (user must enable first for an actual cleanup).
      const saveRes = await fetch(`${apiBase}/api/storage/cleanup-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(base),
        signal,
      });
      if (signal.aborted) return;
      if (!saveRes.ok) {
        setError(t("storage.policy.saveFailed"));
        return;
      }
      const saved = (await saveRes.json()) as {
        policy?: CleanupPolicy;
        error?: string;
      };
      if (signal.aborted) return;
      if (!saved.policy) {
        setError(t("storage.policy.saveFailed"));
        return;
      }
      applyPolicy(saved.policy);

      const res = await fetch(`${apiBase}/api/storage/cleanup-policy/run`, {
        method: "POST",
        signal,
      });
      if (signal.aborted) return;
      if (res.status === 409) {
        const conflict = (await res.json().catch(() => ({}))) as {
          error?: string;
          policy?: CleanupPolicy;
        };
        if (signal.aborted) return;
        if (conflict.policy) applyPolicy(conflict.policy);
        setError(t("storage.policy.alreadyRunning"));
        return;
      }
      if (!res.ok) {
        const failed = (await res.json().catch(() => ({}))) as {
          error?: string;
          policy?: CleanupPolicy;
        };
        if (signal.aborted) return;
        if (failed.policy) applyPolicy(failed.policy);
        if (failed.error === "already_running") {
          setError(t("storage.policy.alreadyRunning"));
          return;
        }
        setError(t("storage.policy.runFailed"));
        return;
      }
      const startJson = (await res.json()) as {
        ok?: boolean;
        started?: boolean;
        error?: string;
        job?: CleanupPolicy["job"];
        policy?: CleanupPolicy;
      };
      if (signal.aborted) return;
      if (startJson.policy) applyPolicy(startJson.policy);
      if (startJson.error === "already_running") {
        setError(t("storage.policy.alreadyRunning"));
        return;
      }
      if (!startJson.started || !startJson.job?.startedAt) {
        setError(t("storage.policy.runFailed"));
        return;
      }

      const startedAt = startJson.job.startedAt;
      const deadline = Date.now() + 120_000;
      let outcome: NonNullable<CleanupPolicy["job"]>["lastOutcome"] | undefined;
      let finalPolicy: CleanupPolicy | undefined;

      while (Date.now() < deadline) {
        if (signal.aborted) return;
        await sleep(250);
        if (signal.aborted) return;
        const pollRes = await fetch(`${apiBase}/api/storage/cleanup-policy`, {
          signal,
        });
        if (signal.aborted) return;
        if (!pollRes.ok) continue;
        const body = (await pollRes.json()) as CleanupPolicy;
        if (signal.aborted) return;
        finalPolicy = policyFieldsFromResponse(body);
        applyPolicy(body);
        const job = body.job;
        if (!job) continue;
        if (job.status === "running") continue;
        if (job.startedAt === startedAt && job.lastOutcome) {
          outcome = job.lastOutcome;
          break;
        }
        if (job.finishedAt && job.finishedAt >= startedAt && job.lastOutcome) {
          outcome = job.lastOutcome;
          break;
        }
      }

      if (signal.aborted) return;
      if (finalPolicy) applyPolicy(finalPolicy);
      if (!outcome) {
        setError(t("storage.policy.runFailed"));
        return;
      }

      if (outcome.skipped === "disabled") {
        setStatus(t("storage.policy.skippedDisabled"));
      } else if (outcome.skipped === "under_threshold") {
        setStatus(t("storage.policy.skippedUnder"));
      } else if (outcome.skipped === "nothing_selected") {
        setStatus(t("storage.policy.skippedEmpty"));
      } else if (
        outcome.deferred === "codex_busy" ||
        outcome.error === "codex_busy"
      ) {
        setError(t("storage.cleanup.err.codex_busy"));
      } else if (!outcome.ok) {
        setError(t("storage.policy.runFailed"));
      } else {
        setStatus(
          outcome.mode === "permanent"
            ? t("storage.policy.donePermanent", {
                count: String(outcome.removed ?? 0),
                size: formatBytes(outcome.freedBytes ?? 0, locale),
              })
            : t("storage.policy.doneQuarantine", {
                count: String(outcome.removed ?? 0),
                size: formatBytes(outcome.freedBytes ?? 0, locale),
              }),
        );
        onDone();
      }
    } catch (err) {
      if (
        signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      )
        return;
      setError(t("storage.policy.runFailed"));
    } finally {
      if (runAbortRef.current === controller) runAbortRef.current = null;
      if (!signal.aborted) setRunning(false);
    }
  };

  const formatWhen = (ms: number | undefined) =>
    ms === undefined
      ? t("storage.policy.never")
      : new Date(ms).toLocaleString(locale);

  if (loading && !policy) {
    return (
      <section className="storage-cleanup-pane">
        <p className="muted storage-policy-help">
          {t("storage.policy.loading")}
        </p>
      </section>
    );
  }

  if (!policy) {
    return (
      <section className="storage-cleanup-pane">
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="storage-cleanup-pane">
      <p className="muted storage-policy-help">{t("storage.policy.help")}</p>

      <div className="storage-policy-enable">
        <div className="storage-policy-enable-row">
          <button
            type="button"
            className={`toggle${policy.enabled ? " on" : ""}`}
            disabled={saving || running}
            aria-pressed={policy.enabled}
            aria-label={t("storage.policy.enabled")}
            title={t("storage.policy.enabledHint")}
            onClick={() => void savePolicy({ enabled: !policy.enabled })}
          >
            <span className="toggle-knob" />
          </button>
          <span>{t("storage.policy.enabled")}</span>
        </div>
      </div>

      <div className="storage-policy-fields">
        <div className="field storage-policy-trigger">
          <label className="field-label" htmlFor="storage-policy-threshold">
            {t("storage.policy.trigger")}
          </label>
          <div className="storage-policy-trigger-row">
            <span className="storage-policy-trigger-hint">
              {t("storage.policy.threshold")}
            </span>
            <span
              className="codex-auto-switch-input-wrap"
              onBlur={(event) => {
                if (
                  event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                )
                  return;
                setEditing(false);
                void savePolicy();
              }}
            >
              <input
                id="storage-policy-threshold"
                className="input mono codex-auto-switch-input"
                type="number"
                min={0}
                step={0.1}
                inputMode="decimal"
                value={thresholdGb}
                disabled={saving || running}
                aria-label={t("storage.policy.threshold")}
                onFocus={() => setEditing(true)}
                onChange={(e) => {
                  markDirty();
                  setThresholdGb(e.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || saving || running)
                    return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void savePolicy();
                  }
                }}
              />
              <span className="codex-auto-switch-unit" aria-hidden="true">
                GiB
              </span>
              <NumberStepper
                disabled={saving || running}
                incrementLabel={t("storage.policy.thresholdInc")}
                decrementLabel={t("storage.policy.thresholdDec")}
                onIncrement={() => {
                  markDirty();
                  setThresholdGb(
                    clampNumberDraft(thresholdGb, 0.1, 0, 10_000, 0.1),
                  );
                }}
                onDecrement={() => {
                  markDirty();
                  setThresholdGb(
                    clampNumberDraft(thresholdGb, -0.1, 0, 10_000, 0.1),
                  );
                }}
              />
            </span>
          </div>
        </div>

        <fieldset className="field storage-policy-target">
          <legend className="field-label">{t("storage.policy.target")}</legend>
          <label className="storage-policy-target-row">
            <input
              type="radio"
              name="storage-policy-target"
              checked={targetMode === "percent"}
              disabled={saving || running}
              onChange={() => {
                markDirty();
                setTargetMode("percent");
              }}
            />
            <span className="storage-policy-target-label">
              {t("storage.policy.targetPercent")}
            </span>
            {targetMode === "percent" && (
              <span
                className="codex-auto-switch-input-wrap"
                onBlur={(event) => {
                  if (
                    event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  )
                    return;
                  setEditing(false);
                  void savePolicy();
                }}
              >
                <input
                  id="storage-policy-percent"
                  className="input mono codex-auto-switch-input"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  inputMode="numeric"
                  value={percent}
                  disabled={saving || running}
                  aria-label={t("storage.policy.targetPercent")}
                  onFocus={() => setEditing(true)}
                  onChange={(e) => {
                    markDirty();
                    setPercent(e.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || saving || running)
                      return;
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void savePolicy();
                    }
                  }}
                />
                <span className="codex-auto-switch-unit" aria-hidden="true">
                  %
                </span>
                <NumberStepper
                  disabled={saving || running}
                  incrementLabel={t("storage.policy.percentInc")}
                  decrementLabel={t("storage.policy.percentDec")}
                  onIncrement={() => {
                    markDirty();
                    setPercent(clampNumberDraft(percent, 1, 1, 100));
                  }}
                  onDecrement={() => {
                    markDirty();
                    setPercent(clampNumberDraft(percent, -1, 1, 100));
                  }}
                />
              </span>
            )}
          </label>
          <label className="storage-policy-target-row">
            <input
              type="radio"
              name="storage-policy-target"
              checked={targetMode === "reduce"}
              disabled={saving || running}
              onChange={() => {
                markDirty();
                setTargetMode("reduce");
              }}
            />
            <span className="storage-policy-target-label">
              {t("storage.policy.targetReduce")}
            </span>
            {targetMode === "reduce" && (
              <span
                className="codex-auto-switch-input-wrap"
                onBlur={(event) => {
                  if (
                    event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  )
                    return;
                  setEditing(false);
                  void savePolicy();
                }}
              >
                <input
                  id="storage-policy-reduce"
                  className="input mono codex-auto-switch-input"
                  type="number"
                  min={0}
                  step={0.1}
                  inputMode="decimal"
                  value={reduceGb}
                  disabled={saving || running}
                  aria-label={t("storage.policy.targetReduce")}
                  onFocus={() => setEditing(true)}
                  onChange={(e) => {
                    markDirty();
                    setReduceGb(e.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || saving || running)
                      return;
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void savePolicy();
                    }
                  }}
                />
                <span className="codex-auto-switch-unit" aria-hidden="true">
                  GiB
                </span>
                <NumberStepper
                  disabled={saving || running}
                  incrementLabel={t("storage.policy.reduceInc")}
                  decrementLabel={t("storage.policy.reduceDec")}
                  onIncrement={() => {
                    markDirty();
                    setReduceGb(
                      clampNumberDraft(reduceGb, 0.1, 0, 10_000, 0.1),
                    );
                  }}
                  onDecrement={() => {
                    markDirty();
                    setReduceGb(
                      clampNumberDraft(reduceGb, -0.1, 0, 10_000, 0.1),
                    );
                  }}
                />
              </span>
            )}
          </label>
        </fieldset>

        <div className="storage-policy-selects">
          <label className="field" htmlFor="storage-policy-schedule">
            <span className="field-label">{t("storage.policy.schedule")}</span>
            <select
              id="storage-policy-schedule"
              className="input"
              value={policy.schedule}
              disabled={saving || running}
              onChange={(e) => {
                const schedule = e.target.value as CleanupPolicy["schedule"];
                void savePolicy({ schedule });
              }}
            >
              <option value="manual">
                {t("storage.policy.schedule.manual")}
              </option>
              <option value="startup">
                {t("storage.policy.schedule.startup")}
              </option>
              <option value="daily">
                {t("storage.policy.schedule.daily")}
              </option>
              <option value="weekly">
                {t("storage.policy.schedule.weekly")}
              </option>
            </select>
          </label>

          <label className="field" htmlFor="storage-policy-mode">
            <span className="field-label">{t("storage.policy.mode")}</span>
            <select
              id="storage-policy-mode"
              className="input"
              value={policy.mode}
              disabled={saving || running}
              onChange={(e) => {
                const mode = e.target.value as CleanupPolicy["mode"];
                void savePolicy({ mode });
              }}
            >
              <option value="quarantine">
                {t("storage.policy.mode.quarantine")}
              </option>
              <option value="permanent">
                {t("storage.policy.mode.permanent")}
              </option>
            </select>
          </label>
        </div>
        {policy.mode === "permanent" && (
          <p className="err storage-policy-warn" role="status">
            {t("storage.policy.permanentWarn")}
          </p>
        )}
      </div>

      <div className="storage-policy-meta">
        <div className="storage-policy-meta-item">
          <span className="muted">{t("storage.policy.lastRun")}</span>
          <span className="storage-policy-meta-value">
            {formatWhen(policy.lastRun?.at)}
            {policy.lastRun
              ? ` · ${t("storage.policy.lastRunDetail", {
                  count: String(policy.lastRun.removed),
                  size: formatBytes(policy.lastRun.freedBytes, locale),
                })}`
              : ""}
          </span>
        </div>
        <div className="storage-policy-meta-item">
          <span className="muted">{t("storage.policy.nextRun")}</span>
          <span className="storage-policy-meta-value">
            {formatWhen(policy.nextRun)}
          </span>
        </div>
      </div>

      <div className="storage-policy-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={saving || running}
          onClick={() => void savePolicy()}
        >
          {t("storage.policy.save")}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={saving || running}
          onClick={() => void runNow()}
        >
          {running ? t("storage.policy.running") : t("storage.policy.runNow")}
        </button>
        <span
          className={`storage-policy-actions__status${error ? " is-error" : ""}`}
          role={error ? "alert" : "status"}
          aria-live="polite"
        >
          {error ?? status ?? ""}
        </span>
      </div>
    </section>
  );
}
