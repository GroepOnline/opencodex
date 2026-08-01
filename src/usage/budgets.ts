/**
 * Token/cost budget tracker with rolling windows.
 *
 * Keeps in-memory daily + weekly counters that reset at local midnight / week
 * boundary. Persists state to ~/.opencodex/budget-state.json so process restarts
 * don't lose the running total. Alerts fire when configured thresholds are crossed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { estimateCostEur } from "./pricing";
import { getServerPosthog, TELEMETRY_EVENTS } from "../telemetry/posthog-server";
import type { OcxUsage } from "../types";

export interface BudgetConfig {
  tokenDaily?: number;
  tokenWeekly?: number;
  costDailyEur?: number;
  alertActions?: Array<"log" | "posthog" | "webhook">;
  webhookUrl?: string;
}

export type BudgetAlertType = "token-daily" | "token-weekly" | "cost-daily";

export interface BudgetAlert {
  type: BudgetAlertType;
  threshold: number;
  actual: number;
  message: string;
}

export interface UsageSummary {
  todayTokens: number;
  weekTokens: number;
  todayCostEur: number;
  limits: { tokenDaily?: number; tokenWeekly?: number; costDailyEur?: number };
}

interface PersistedState {
  /** Epoch ms for the day the counters apply to. */
  dayStart: number;
  /** Epoch ms for the week the counters apply to (Monday 00:00 local). */
  weekStart: number;
  todayTokens: number;
  todayCostEur: number;
  weekTokens: number;
}

/** Returns local-midnight epoch ms for the given timestamp's day. */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Returns local Monday 00:00 epoch ms for the given timestamp's week. */
function startOfWeek(ts: number): number {
  const d = new Date(startOfDay(ts));
  const dow = d.getDay(); // 0=Sun ... 6=Sat
  const diff = dow === 0 ? -6 : 1 - dow; // back to Monday
  d.setDate(d.getDate() + diff);
  return d.getTime();
}

export class BudgetTracker {
  private state: PersistedState;
  private readonly config: BudgetConfig;
  /** Already-fired alerts (dedupe within a window so we don't spam). */
  private readonly fired = new Set<string>();
  private readonly statePath: string;
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: BudgetConfig = {}) {
    this.config = config;
    this.statePath = join(getConfigDir(), "budget-state.json");
    this.state = this.load();
    this.startFlushTimer();
  }

  private load(): PersistedState {
    const now = Date.now();
    const fresh: PersistedState = {
      dayStart: startOfDay(now),
      weekStart: startOfWeek(now),
      todayTokens: 0,
      todayCostEur: 0,
      weekTokens: 0,
    };
    try {
      if (!existsSync(this.statePath)) return fresh;
      const parsed = JSON.parse(readFileSync(this.statePath, "utf-8")) as PersistedState;
      if (!parsed || typeof parsed !== "object") return fresh;
      // Roll over windows if we've crossed a boundary.
      if (startOfDay(now) !== parsed.dayStart) {
        parsed.todayTokens = 0;
        parsed.todayCostEur = 0;
        parsed.dayStart = startOfDay(now);
      }
      if (startOfWeek(now) !== parsed.weekStart) {
        parsed.weekTokens = 0;
        parsed.weekStart = startOfWeek(now);
      }
      return { ...fresh, ...parsed };
    } catch {
      return fresh;
    }
  }

  private persist(): void {
    try {
      mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
      writeFileSync(this.statePath, JSON.stringify(this.state), { mode: 0o600 });
      try { chmodSync(this.statePath, 0o600); } catch { /* best-effort */ }
    } catch {
      /* persistence is best-effort */
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      if (this.dirty) {
        this.persist();
        this.dirty = false;
      }
    }, 5_000);
    this.flushTimer.unref?.();
  }

  shutdown(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.dirty) this.persist();
  }

  /**
   * Roll the day/week counters forward when the process has crossed a local
   * midnight or Monday boundary since the last touch. `load()` only runs at
   * construction, and the tracker is a long-lived singleton, so every read and
   * write has to re-check the window or a proxy left running overnight keeps
   * reporting (and alerting on) the previous window's totals.
   */
  private rollWindows(now = Date.now()): void {
    const dayStart = startOfDay(now);
    if (dayStart !== this.state.dayStart) {
      this.state.todayTokens = 0;
      this.state.todayCostEur = 0;
      this.state.dayStart = dayStart;
      this.dirty = true;
    }
    const weekStart = startOfWeek(now);
    if (weekStart !== this.state.weekStart) {
      this.state.weekTokens = 0;
      this.state.weekStart = weekStart;
      this.dirty = true;
    }
  }

  /**
   * Record a completed request's usage. Returns any alerts that crossed a
   * threshold on this call (empty array if under budget / unconfigured).
   */
  recordUsage(provider: string, model: string | undefined, usage: OcxUsage | undefined): BudgetAlert[] {
    if (!usage) return [];
    const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    if (tokens <= 0) return [];
    const cost = estimateCostEur(provider, model, usage.inputTokens ?? 0, usage.outputTokens ?? 0);

    this.rollWindows();
    this.state.todayTokens += tokens;
    this.state.weekTokens += tokens;
    this.state.todayCostEur += cost;
    this.dirty = true;

    return this.checkThresholds();
  }

  private checkThresholds(): BudgetAlert[] {
    const alerts: BudgetAlert[] = [];
    const cfg = this.config;

    if (cfg.tokenDaily && this.state.todayTokens >= cfg.tokenDaily) {
      const key = `token-daily-${this.state.dayStart}`;
      if (!this.fired.has(key)) {
        this.fired.add(key);
        alerts.push({
          type: "token-daily",
          threshold: cfg.tokenDaily,
          actual: this.state.todayTokens,
          message: `Daily token budget reached: ${this.state.todayTokens.toLocaleString()} / ${cfg.tokenDaily.toLocaleString()} tokens`,
        });
      }
    }
    if (cfg.tokenWeekly && this.state.weekTokens >= cfg.tokenWeekly) {
      const key = `token-weekly-${this.state.weekStart}`;
      if (!this.fired.has(key)) {
        this.fired.add(key);
        alerts.push({
          type: "token-weekly",
          threshold: cfg.tokenWeekly,
          actual: this.state.weekTokens,
          message: `Weekly token budget reached: ${this.state.weekTokens.toLocaleString()} / ${cfg.tokenWeekly.toLocaleString()} tokens`,
        });
      }
    }
    if (cfg.costDailyEur && this.state.todayCostEur >= cfg.costDailyEur) {
      const key = `cost-daily-${this.state.dayStart}`;
      if (!this.fired.has(key)) {
        this.fired.add(key);
        alerts.push({
          type: "cost-daily",
          threshold: cfg.costDailyEur,
          actual: this.state.todayCostEur,
          message: `Daily cost budget reached: €${this.state.todayCostEur.toFixed(2)} / €${cfg.costDailyEur.toFixed(2)}`,
        });
      }
    }

    for (const alert of alerts) this.dispatchAlert(alert);
    return alerts;
  }

  private dispatchAlert(alert: BudgetAlert): void {
    const actions = this.config.alertActions ?? ["log"];
    for (const action of actions) {
      try {
        if (action === "log") {
          console.warn(`[ocx:budget] ${alert.message}`);
        } else if (action === "posthog") {
          getServerPosthog()?.capture(TELEMETRY_EVENTS.BUDGET_EXCEEDED, {
            type: alert.type,
            threshold: alert.threshold,
            actual: alert.actual,
          });
        } else if (action === "webhook" && this.config.webhookUrl) {
          void fetch(this.config.webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ alert }),
            signal: AbortSignal.timeout(3_000),
          }).catch(() => { /* best-effort */ });
        }
      } catch {
        /* alert dispatch never throws */
      }
    }
  }

  getUsageSummary(): UsageSummary {
    this.rollWindows();
    return {
      todayTokens: this.state.todayTokens,
      weekTokens: this.state.weekTokens,
      todayCostEur: this.state.todayCostEur,
      limits: {
        tokenDaily: this.config.tokenDaily,
        tokenWeekly: this.config.tokenWeekly,
        costDailyEur: this.config.costDailyEur,
      },
    };
  }
}

let cachedTracker: BudgetTracker | undefined;

/** Singleton — constructed lazily from config on first use. */
export function getBudgetTracker(config?: BudgetConfig): BudgetTracker {
  if (!cachedTracker) {
    cachedTracker = new BudgetTracker(config ?? {});
  }
  return cachedTracker;
}

/** Reset singleton (for tests). */
export function resetBudgetTracker(): void {
  cachedTracker?.shutdown();
  cachedTracker = undefined;
}
