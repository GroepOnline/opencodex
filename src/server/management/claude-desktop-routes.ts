import { readAppliedDesktop3pLibrary } from "../../claude/desktop-3p";
import { saveConfigPreservingClaudeCode } from "../../config";
import { jsonResponse, withNoStore } from "../auth-cors";
import { buildClaudeDesktopState } from "./shared";
import type { ManagementContext } from "./context";

/** Claude Desktop management endpoints, called only after the global management-auth boundary. */
export async function handleClaudeDesktopRoutes(
  ctx: ManagementContext,
): Promise<Response | null> {
  const { req, url, config } = ctx;

  // Claude Desktop profile: routed/native model assignments for the Desktop 3P config.
  if (url.pathname === "/api/claude-desktop" && req.method === "GET") {
    try {
      const state = await buildClaudeDesktopState(config);
      const runtimePort = Number(url.port) || config.port;
      return jsonResponse({ ...state, port: runtimePort });
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  }
  if (url.pathname === "/api/claude-desktop" && req.method === "PUT") {
    let body: { profile?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    try {
      const { parseDesktopProfile } =
        await import("../../claude/desktop-profile");
      const parsed = parseDesktopProfile(body.profile);
      const current = await buildClaudeDesktopState(config);
      for (const model of current.models.filter((item) => !item.available)) {
        const before = current.profile.assignments[model.route];
        const after = parsed.assignments[model.route];
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          throw new Error(
            `현재 사용할 수 없는 모델은 옮길 수 없습니다: ${model.route}`,
          );
        }
      }
      for (const family of ["opus", "fable", "sonnet", "haiku"] as const) {
        const nextDefault = parsed.defaults[family];
        const target = nextDefault
          ? current.models.find((model) => model.route === nextDefault)
          : undefined;
        if (
          target &&
          !target.available &&
          current.profile.defaults[family] !== nextDefault
        ) {
          throw new Error(
            `현재 사용할 수 없는 모델은 기본값으로 지정할 수 없습니다: ${nextDefault}`,
          );
        }
      }
      config.claudeCode = {
        ...(config.claudeCode ?? {}),
        desktopProfile: parsed,
      };
      saveConfigPreservingClaudeCode(config);
      const saved = await buildClaudeDesktopState(config);
      const runtimePort = Number(url.port) || config.port;
      return jsonResponse({ ok: true, ...saved, port: runtimePort });
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  }
  if (url.pathname === "/api/claude-desktop/apply" && req.method === "POST") {
    try {
      const state = await buildClaudeDesktopState(config);
      config.claudeCode = {
        ...(config.claudeCode ?? {}),
        desktopProfile: state.profile,
      };
      saveConfigPreservingClaudeCode(config);
      const { writeDesktop3pConfig } = await import("../../claude/desktop-3p");
      const { visibleNativeSlugs } = await import("../../codex/catalog");
      const routed = state.models
        .filter(
          (model) => model.available && !model.route.startsWith("native/"),
        )
        .map((model) => {
          const slash = model.route.indexOf("/");
          return {
            provider: model.route.slice(0, slash),
            id: model.route.slice(slash + 1),
            contextWindow: model.contextWindow,
          };
        });
      const result = writeDesktop3pConfig(
        Number(url.port) || config.port,
        [...visibleNativeSlugs(config)],
        routed,
        config.apiKeys?.[0]?.key,
        "static",
        state.profile,
      );
      if (!result.written)
        return jsonResponse(
          {
            error: result.reason ?? "Claude Desktop apply failed",
            saved: true,
            path: result.path,
          },
          500,
        );
      // Persist applied fingerprint + timestamp so GUI can show saved-vs-applied state.
      if (result.fingerprint) {
        config.claudeCode = {
          ...(config.claudeCode ?? {}),
          desktopProfile: {
            ...state.profile,
            appliedFingerprint: result.fingerprint,
            appliedAt: new Date().toISOString(),
          },
        };
        saveConfigPreservingClaudeCode(config);
      }
      return jsonResponse({
        ok: true,
        saved: true,
        applied: true,
        path: result.path,
        fingerprint: result.fingerprint,
        laptopSync: "ocx-desktop://sync",
      });
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  }

  // Laptop Claude Desktop reads ~/.config/Claude-3p, not chef's homedir on the
  // proxy host. This payload is the applied 3P library so a local handler can
  // copy it through the ocx-tunnel without SSH.
  if (
    url.pathname === "/api/claude-desktop/3p-library" &&
    req.method === "GET"
  ) {
    const noStoreJson = (data: unknown, status = 200) =>
      withNoStore(jsonResponse(data, status, req, config));
    try {
      const library = readAppliedDesktop3pLibrary();
      if (!library.ok)
        return noStoreJson({ error: library.error }, library.status);
      return noStoreJson(library);
    } catch (error) {
      return noStoreJson(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  }

  // Desktop applied-state + health status.
  if (url.pathname === "/api/claude-desktop/status" && req.method === "GET") {
    try {
      const { readFileSync: readFile, existsSync } = await import("node:fs");
      const { createHash } = await import("node:crypto");
      const { join } = await import("node:path");
      const { resolveDesktop3pConfigLibraryPath } =
        await import("../../claude/desktop-3p");
      const libraryPath = resolveDesktop3pConfigLibraryPath();
      const metaPath = join(libraryPath, "_meta.json");
      let onDiskFingerprint: string | null = null;
      let configPath: string | null = null;
      // Desktop serves ONLY the profile named by _meta.json's appliedId, so an
      // opencodex entry that merely EXISTS does not mean Desktop is using it.
      // null = undeterminable (no metadata / unreadable / no appliedId).
      let activeProfile: boolean | null = null;
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFile(metaPath, "utf8"));
          const entry = Array.isArray(meta.entries)
            ? meta.entries.find(
                (e: { name?: string }) => e?.name === "opencodex",
              )
            : undefined;
          const appliedId =
            typeof meta.appliedId === "string" ? meta.appliedId : null;
          // A readable appliedId with no opencodex entry is a KNOWN false, not unknown.
          activeProfile =
            appliedId === null
              ? null
              : entry?.id
                ? appliedId === entry.id
                : false;
          if (entry?.id) {
            configPath = join(libraryPath, `${entry.id}.json`);
            if (existsSync(configPath)) {
              const onDisk = readFile(configPath, "utf8");
              onDiskFingerprint = createHash("sha256")
                .update(onDisk)
                .digest("hex")
                .slice(0, 16);
            }
          }
        } catch {
          /* unreadable metadata */
        }
      }
      const savedFingerprint =
        config.claudeCode?.desktopProfile?.appliedFingerprint ?? null;
      const appliedAt = config.claudeCode?.desktopProfile?.appliedAt ?? null;
      const stale =
        savedFingerprint !== null &&
        onDiskFingerprint !== null &&
        savedFingerprint !== onDiskFingerprint;
      const { getDesktopHealth } = await import("../../claude/desktop-health");
      const health = getDesktopHealth();
      return jsonResponse({
        applied: savedFingerprint !== null,
        appliedAt,
        savedFingerprint,
        onDiskFingerprint,
        configPath,
        stale,
        activeProfile,
        health,
      });
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  }

  return null;
}
