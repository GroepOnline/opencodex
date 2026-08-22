/**
 * /api/router — observability for the Fase E auto-router.
 *
 * GET returns the effective mode/weights plus, per configured provider fallback chain,
 * the scored target order the router WOULD pick right now (cost from static pricing,
 * latency from usage-log p50, quality from the tier table). Scalar-only payload: no
 * keys, no prompts — same privacy rule as /api/response-cache.
 *
 * POST toggles `router.mode` in the live config (persisted via saveConfig) so the GUI
 * can flip auto-routing without a hand edit. Requires an explicit mode value.
 */
import { jsonResponse } from "../auth-cors";
import { saveConfigPreservingClaudeCode } from "../../config";
import {
  autoRouterEnabled,
  autoRouterWeights,
  blendedCostPer1k,
  qualityTierForModel,
  reorderChainTargets,
} from "../../router-auto";
import { p50DurationForModel } from "../../usage/latency-history";
import { usableProviderFallbackTargets } from "../../providers/fallback";
import type { ManagementContext } from "./context";

export async function handleRouterRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/router" && req.method === "GET") {
    const enabled = autoRouterEnabled(config);
    const weights = autoRouterWeights(config);
    const chains: Array<{ provider: string; model: string; scored: Array<Record<string, unknown>> }> = [];
    if (enabled) {
      const now = Date.now();
      for (const [providerName, prov] of Object.entries(config.providers)) {
        if (!prov || prov.disabled === true) continue;
        const modelId = prov.defaultModel ?? prov.models?.[0];
        if (!modelId) continue;
        const targets = usableProviderFallbackTargets(config, { provider: providerName, modelId });
        if (!targets) continue;
        // Honor the window reorderChainTargets computes from config.router.latencyWindowMs
        // (passed as sinceMs) so this inspect view matches the order live routing picks.
        const scored = reorderChainTargets(config, targets, {
          p50DurationMs: (p, m, sinceMs) => p50DurationForModel(p, m, sinceMs, now),
        }, now);
        chains.push({
          provider: providerName,
          model: modelId,
          scored: scored.map(row => ({
            provider: row.target.provider,
            model: row.target.model,
            score: Math.round(row.score * 1000) / 1000,
            components: {
              cost: Math.round(row.components.cost * 100) / 100,
              latency: Math.round(row.components.latency * 100) / 100,
              quality: qualityTierForModel(row.target.model),
            },
            costPer1kEur: Math.round(blendedCostPer1k(row.target.provider, row.target.model) * 1e6) / 1e6,
          })),
        });
      }
    }
    return jsonResponse({
      mode: config.router?.mode ?? "off",
      enabled,
      weights,
      chains,
    }, 200, req, config);
  }

  if (url.pathname === "/api/router" && req.method === "PUT") {
    let body: { mode?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid_json" }, 400, req, config); }
    if (body.mode !== "off" && body.mode !== "auto") {
      return jsonResponse({ error: "mode must be \"off\" or \"auto\"" }, 400, req, config);
    }
    config.router = { ...config.router, mode: body.mode };
    saveConfigPreservingClaudeCode(config);
    return jsonResponse({ success: true, mode: body.mode }, 200, req, config);
  }

  return null;
}
