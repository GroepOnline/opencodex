import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, saveConfigPreservingClaudeCode } from "../config";
import {
  DESKTOP_FAMILIES,
  moveDesktopRoute,
  parseDesktopProfile,
  removeDesktopRoute,
  setDesktopFamilyDefault,
  type DesktopFamily,
  type DesktopProfile,
} from "../claude/desktop-profile";
import {
  readAppliedDesktop3pLibrary,
  resolveDesktop3pConfigLibraryPath,
  writeDesktop3pConfig,
  type Desktop3pConfigMode,
  parseDesktop3pModeArgs,
} from "../claude/desktop-3p";
import {
  filterCatalogVisibleModels,
  visibleNativeSlugs,
} from "../codex/catalog";
import {
  buildClaudeDesktopState,
  fetchAllModels,
} from "../server/management-api";
import { findLiveProxy } from "../server/proxy-liveness";
import {
  assertClaudeDesktopProtocolUri,
  claimClaudeDesktopProtocolDispatch,
  getClaudeDesktopProtocolStatus,
  installClaudeDesktopProtocol,
  repairClaudeDesktopProtocol,
  uninstallClaudeDesktopProtocol,
  type DesktopProtocolOptions,
} from "../claude/desktop-protocol";
import type { DesktopSyncResult } from "../claude/desktop-sync";

export interface ClaudeDesktopCommandOptions {
  protocolOptions?: DesktopProtocolOptions;
  syncLibrary?: () => Promise<DesktopSyncResult>;
}

function isFamily(value: string | undefined): value is DesktopFamily {
  return !!value && (DESKTOP_FAMILIES as readonly string[]).includes(value);
}

function printDesktopHelp(): void {
  console.log(`Usage:
  ocx claude desktop [apply] [--static|--hybrid|--discovery-only]
  ocx claude desktop sync
  ocx claude desktop doctor [--json]
  ocx claude desktop protocol <install|status|uninstall>
  ocx claude desktop protocol dispatch <uri>
  ocx claude desktop show [--json]
  ocx claude desktop move <provider/model> <opus|fable|sonnet|haiku> [--default]
  ocx claude desktop remove <provider/model>
  ocx claude desktop default <family> <provider/model|none>
  ocx claude desktop export <path|->
  ocx claude desktop import <path> [--apply]`);
}

async function runSync(
  options: ClaudeDesktopCommandOptions,
  automatic: boolean,
): Promise<number> {
  try {
    const { syncClaudeDesktopLibrary } = await import("../claude/desktop-sync");
    const result = await (
      options.syncLibrary ?? (() => syncClaudeDesktopLibrary({ automatic }))
    )();
    console.log(
      `Claude Desktop: ${result.models} models ${result.status}. Active sessions were not restarted.`,
    );
    return 0;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Claude Desktop sync failed",
    );
    return 1;
  }
}

interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

type AddDoctorCheck = (
  name: string,
  status: DoctorCheck["status"],
  detail: string,
) => void;

function checkDoctorLibrary(add: AddDoctorCheck): Set<string> | null {
  let appliedAliases: Set<string> | null = null;
  try {
    const libraryPath = resolveDesktop3pConfigLibraryPath();
    const applied = readAppliedDesktop3pLibrary();
    if (!applied.ok) {
      add(
        "library",
        "fail",
        `${applied.error} (${libraryPath}); run: ocx claude desktop apply`,
      );
    } else {
      const config = (
        applied.config && typeof applied.config === "object"
          ? applied.config
          : {}
      ) as Record<string, unknown>;
      const models = (
        Array.isArray(config.inferenceModels) ? config.inferenceModels : []
      ).filter(
        (model): model is Record<string, unknown> =>
          !!model && typeof model === "object",
      );
      appliedAliases = new Set(models.map((model) => String(model.name)));
      const mode =
        config.modelDiscoveryEnabled === false ? "static" : "hybrid/discovery";
      const oneM = models.filter((model) => model.supports1m === true).length;
      add(
        "library",
        "ok",
        `${models.length} models (${mode}${oneM ? `, ${oneM} with 1M` : ""}), id ${applied.appliedId}, fingerprint ${applied.fingerprint}`,
      );
    }
  } catch (error) {
    add(
      "library",
      "fail",
      error instanceof Error ? error.message : String(error),
    );
  }
  return appliedAliases;
}

async function checkDoctorProfileDrift(
  aliases: Set<string>,
  add: AddDoctorCheck,
): Promise<void> {
  try {
    const state = await buildClaudeDesktopState(loadConfig());
    const expected = state.models
      .filter((model) => model.available)
      .map((model) => model.assignment.alias);
    const missing = expected.filter((alias) => !aliases.has(alias));
    const stale = [...aliases].filter((alias) => !expected.includes(alias));
    if (missing.length === 0 && stale.length === 0)
      add("profile drift", "ok", "applied library matches the saved profile");
    else
      add(
        "profile drift",
        "warn",
        `${missing.length} route(s) missing and ${stale.length} stale alias(es) in the applied library; run: ocx claude desktop apply`,
      );
  } catch (error) {
    add(
      "profile drift",
      "warn",
      `could not compare profile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function checkDoctorSyncLink(
  options: ClaudeDesktopCommandOptions,
  add: AddDoctorCheck,
): void {
  try {
    const protocol = getClaudeDesktopProtocolStatus(options.protocolOptions);
    if (protocol.status === "installed" && protocol.registered === false) {
      add(
        "sync link",
        "warn",
        "handler file installed but not the default for ocx-desktop://; run: ocx claude desktop protocol install",
      );
    } else if (
      protocol.status === "orphaned" ||
      protocol.status === "missing"
    ) {
      add(
        "sync link",
        "warn",
        `${protocol.status}; run: ocx claude desktop protocol install`,
      );
    } else {
      add(
        "sync link",
        "ok",
        protocol.status === "absent" ? "not installed (optional)" : "installed",
      );
    }
  } catch (error) {
    add(
      "sync link",
      "fail",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function checkDoctorGateway(add: AddDoctorCheck): Promise<void> {
  try {
    const live = await findLiveProxy();
    if (!live) {
      add("gateway", "warn", "no running proxy; start it with: ocx start");
    } else {
      const response = await fetch(`http://127.0.0.1:${live.port}/healthz`, {
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      add(
        "gateway",
        response.ok ? "ok" : "fail",
        `http://127.0.0.1:${live.port} answered HTTP ${response.status}`,
      );
    }
  } catch (error) {
    add(
      "gateway",
      "fail",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** One-shot health report: applied library, profile drift, link handler and live gateway. */
async function runDoctor(
  options: ClaudeDesktopCommandOptions,
  json: boolean,
): Promise<number> {
  const checks: DoctorCheck[] = [];
  const add: AddDoctorCheck = (name, status, detail) => {
    checks.push({ name, status, detail });
  };

  const appliedAliases = checkDoctorLibrary(add);
  if (appliedAliases) await checkDoctorProfileDrift(appliedAliases, add);
  if (process.platform === "linux") checkDoctorSyncLink(options, add);
  await checkDoctorGateway(add);

  const failed = checks.some((check) => check.status === "fail");
  if (json) {
    console.log(JSON.stringify({ ok: !failed, checks }));
  } else {
    const icon = { ok: "✅", warn: "⚠️ ", fail: "❌" } as const;
    for (const check of checks)
      console.log(`${icon[check.status]} ${check.name}: ${check.detail}`);
  }
  return failed ? 1 : 0;
}

async function applyProfile(
  profile: DesktopProfile,
  mode: Desktop3pConfigMode,
): Promise<{ ok: boolean; path: string; reason?: string }> {
  const config = loadConfig();
  const state = await buildClaudeDesktopState(config, profile);
  config.claudeCode = {
    ...(config.claudeCode ?? {}),
    desktopProfile: state.profile,
  };
  saveConfigPreservingClaudeCode(config);
  const live = await findLiveProxy();
  const allModels = await fetchAllModels(config);
  const routed = filterCatalogVisibleModels(allModels, config).map((model) => ({
    provider: model.provider,
    id: model.id,
    contextWindow: model.contextWindow,
  }));
  const result = writeDesktop3pConfig(
    live?.port ?? config.port ?? 10100,
    [...visibleNativeSlugs(config)],
    routed,
    config.apiKeys?.[0]?.key,
    mode,
    state.profile,
  );
  return { ok: result.written, path: result.path, reason: result.reason };
}

export async function handleClaudeDesktopCommand(
  argv: string[],
  options: ClaudeDesktopCommandOptions = {},
): Promise<number> {
  const command = argv[0];
  if (command === "help" || command === "--help" || command === "-h") {
    printDesktopHelp();
    return 0;
  }

  if (command === "protocol") {
    const action = argv[1];
    try {
      if (action === "dispatch") {
        if (argv.length !== 3)
          throw new Error("Usage: ocx claude desktop protocol dispatch <uri>");
        assertClaudeDesktopProtocolUri(argv[2]!, options.protocolOptions);
        // Any web page can open this link: collapse bursts into one sync and never fail loudly
        // for an unconfigured install (automatic mode skips instead of erroring).
        if (!claimClaudeDesktopProtocolDispatch(options.protocolOptions)) {
          console.log(
            "Claude Desktop sync skipped: another sync was dispatched moments ago.",
          );
          return 0;
        }
        return await runSync(options, true);
      }
      // Internal package-update hook; unlike install, it never opts an absent handler in.
      if (action === "__repair") {
        if (argv.length !== 2)
          throw new Error("Usage: ocx claude desktop protocol __repair");
        const result = repairClaudeDesktopProtocol(options.protocolOptions);
        console.log(`Claude Desktop protocol: ${result.status}.`);
        return 0;
      }
      if (
        argv.length !== 2 ||
        !["install", "status", "uninstall"].includes(action ?? "")
      ) {
        throw new Error(
          "Usage: ocx claude desktop protocol <install|status|uninstall>",
        );
      }
      const result =
        action === "install"
          ? installClaudeDesktopProtocol(options.protocolOptions)
          : action === "uninstall"
            ? uninstallClaudeDesktopProtocol(options.protocolOptions)
            : getClaudeDesktopProtocolStatus(options.protocolOptions);
      console.log(`Claude Desktop protocol: ${result.status}.`);
      if (result.registered === false) {
        console.log(
          "The handler is installed but is not the default for ocx-desktop:// links; re-run: ocx claude desktop protocol install",
        );
      }
      if (result.status === "orphaned") {
        console.log(
          "An OCX-generated Desktop entry exists without ownership state; run install to adopt it or uninstall to remove it.",
        );
      }
      if (result.associationRemoved)
        console.log("Removed the ocx-desktop:// default-handler association.");
      return 0;
    } catch (error) {
      console.error(
        error instanceof Error
          ? error.message
          : "Claude Desktop protocol command failed",
      );
      return 1;
    }
  }

  if (command === "sync") {
    if (argv.length !== 1) {
      console.error("Usage: ocx claude desktop sync");
      return 1;
    }
    return await runSync(options, false);
  }

  if (command === "doctor") {
    if (argv.length > 2 || (argv[1] && argv[1] !== "--json")) {
      console.error("Usage: ocx claude desktop doctor [--json]");
      return 1;
    }
    return await runDoctor(options, argv[1] === "--json");
  }

  // Legacy mode flags remain apply aliases and are parsed before subcommands.
  const legacyFlags = argv.filter((arg) =>
    ["--static", "--hybrid", "--discovery-only"].includes(arg),
  );
  const applyInvocation =
    argv.length === 0 || command === "apply" || legacyFlags.length > 0;
  if (applyInvocation) {
    const nonMode = argv.filter(
      (arg) =>
        !["apply", "--static", "--hybrid", "--discovery-only"].includes(arg),
    );
    if (nonMode.length > 0) {
      console.error(`알 수 없는 인자: ${nonMode.join(" ")}`);
      return 1;
    }
    const parsedMode = parseDesktop3pModeArgs(legacyFlags);
    if ("error" in parsedMode) {
      console.error(parsedMode.error);
      return 1;
    }
    try {
      const config = loadConfig();
      const state = await buildClaudeDesktopState(config);
      const result = await applyProfile(state.profile, parsedMode.mode);
      if (!result.ok) {
        console.error(`설정 적용 실패: ${result.reason ?? "unknown error"}`);
        return 1;
      }
      console.log(`Claude Desktop 설정을 적용했습니다: ${result.path}`);
      console.log(
        "Active sessions were not restarted. Desktop may retain its current picker until it reloads configuration.",
      );
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  try {
    const config = loadConfig();
    const state = await buildClaudeDesktopState(config);
    if (command === "show") {
      if (argv.length > 2 || (argv[1] && argv[1] !== "--json"))
        throw new Error("Usage: ocx claude desktop show [--json]");
      if (argv[1] === "--json") console.log(JSON.stringify(state));
      else {
        for (const family of DESKTOP_FAMILIES) {
          console.log(
            `${family.toUpperCase()}${state.profile.defaults[family] ? ` (default: ${state.profile.defaults[family]})` : ""}`,
          );
          for (const model of state.models.filter(
            (item) => item.assignment.family === family,
          )) {
            console.log(
              `  ${model.available ? "•" : "○"} ${model.route} -> ${model.assignment.alias}${model.available ? "" : " (unavailable)"}`,
            );
          }
        }
      }
      return 0;
    }
    if (command === "move") {
      const [, route, familyRaw, ...flags] = argv;
      if (
        !route ||
        !isFamily(familyRaw) ||
        flags.some((flag) => flag !== "--default")
      )
        throw new Error(
          "Usage: ocx claude desktop move <route> <family> [--default]",
        );
      if (
        !state.models.some((model) => model.route === route && model.available)
      )
        throw new Error(`현재 사용할 수 없는 모델입니다: ${route}`);
      const profile = moveDesktopRoute(
        state.profile,
        route,
        familyRaw,
        flags.includes("--default"),
      );
      config.claudeCode = {
        ...(config.claudeCode ?? {}),
        desktopProfile: profile,
      };
      saveConfigPreservingClaudeCode(config);
      console.log(`${route} 모델을 ${familyRaw} 그룹으로 옮겼습니다.`);
      return 0;
    }
    if (command === "remove") {
      const route = argv[1];
      if (!route || argv.length !== 2)
        throw new Error("Usage: ocx claude desktop remove <route>");
      const profile = removeDesktopRoute(state.profile, route);
      config.claudeCode = {
        ...(config.claudeCode ?? {}),
        desktopProfile: profile,
      };
      saveConfigPreservingClaudeCode(config);
      console.log(`${route} 모델을 Claude Desktop 프로필에서 제거했습니다.`);
      return 0;
    }
    if (command === "default") {
      const [, familyRaw, routeRaw] = argv;
      if (!isFamily(familyRaw) || !routeRaw || argv.length !== 3)
        throw new Error(
          "Usage: ocx claude desktop default <family> <route|none>",
        );
      const route = routeRaw === "none" ? null : routeRaw;
      if (
        route &&
        !state.models.some((model) => model.route === route && model.available)
      )
        throw new Error(`현재 사용할 수 없는 모델입니다: ${route}`);
      const profile = setDesktopFamilyDefault(state.profile, familyRaw, route);
      config.claudeCode = {
        ...(config.claudeCode ?? {}),
        desktopProfile: profile,
      };
      saveConfigPreservingClaudeCode(config);
      console.log(
        `${familyRaw} 기본 모델을 ${route ?? "없음"}으로 지정했습니다.`,
      );
      return 0;
    }
    if (command === "export") {
      const target = argv[1];
      if (!target || argv.length !== 2)
        throw new Error("Usage: ocx claude desktop export <path|->");
      const json = JSON.stringify(state.profile, null, 2) + "\n";
      if (target === "-") process.stdout.write(json);
      else
        writeFileSync(resolve(target), json, { encoding: "utf8", mode: 0o600 });
      return 0;
    }
    if (command === "import") {
      const source = argv[1];
      const flags = argv.slice(2);
      if (!source || flags.some((flag) => flag !== "--apply"))
        throw new Error("Usage: ocx claude desktop import <path> [--apply]");
      const profile = parseDesktopProfile(
        JSON.parse(readFileSync(resolve(source), "utf8")),
      );
      const reconciled = (await buildClaudeDesktopState(config, profile))
        .profile;
      config.claudeCode = {
        ...(config.claudeCode ?? {}),
        desktopProfile: reconciled,
      };
      saveConfigPreservingClaudeCode(config);
      if (flags.includes("--apply")) {
        const result = await applyProfile(reconciled, "static");
        if (!result.ok) {
          console.error(
            `프로필은 저장했지만 Desktop 적용에 실패했습니다: ${result.reason ?? "unknown error"}`,
          );
          return 1;
        }
      }
      console.log("Claude Desktop 프로필을 가져왔습니다.");
      return 0;
    }
    printDesktopHelp();
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
