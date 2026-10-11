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
  writeDesktop3pConfigAsync,
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
import { findLiveProxy, probeHostname } from "../server/proxy-liveness";
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

/** Narrow a CLI argument to one of the four Desktop model families. */
function isFamily(value: string | undefined): value is DesktopFamily {
  return !!value && (DESKTOP_FAMILIES as readonly string[]).includes(value);
}

/** Print the `ocx claude desktop` usage summary. */
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

/** Run a Desktop library sync; `automatic` skips unconfigured installs instead of failing them. */
async function runSync(options: ClaudeDesktopCommandOptions, automatic: boolean): Promise<number> {
  try {
    const { syncClaudeDesktopLibrary } = await import("../claude/desktop-sync");
    const result = await (options.syncLibrary ?? (() => syncClaudeDesktopLibrary({ automatic })))();
    console.log(`Claude Desktop: ${result.models} models ${result.status}. Active sessions were not restarted.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Claude Desktop sync failed");
    return 1;
  }
}

/** One line of the `doctor` report. `fail` makes the command exit nonzero; `warn` is advisory. */
export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Inspect the applied Desktop library. `aliases` is the set of applied model aliases, or null when
 * the library is missing or malformed and a profile comparison would be meaningless.
 */
function checkAppliedLibrary(): { check: DoctorCheck; aliases: Set<string> | null } {
  const fail = (detail: string) => ({ check: { name: "library", status: "fail" as const, detail }, aliases: null });
  try {
    const libraryPath = resolveDesktop3pConfigLibraryPath();
    const applied = readAppliedDesktop3pLibrary();
    if (!applied.ok) return fail(`${applied.error} (${libraryPath}); run: ocx claude desktop apply`);
    const config = (applied.config && typeof applied.config === "object" ? applied.config : {}) as Record<string, unknown>;
    const entries = Array.isArray(config.inferenceModels) ? config.inferenceModels : [];
    const models = entries.filter((model): model is Record<string, unknown> => !!model && typeof model === "object");
    // A model without a usable name is corrupt library data, not something to hide from the report.
    const unnamed = entries.length - models.filter(model => typeof model.name === "string" && model.name !== "").length;
    if (unnamed > 0) {
      return fail(`${unnamed} applied model(s) have no usable name (${libraryPath}); run: ocx claude desktop apply`);
    }
    const mode = config.modelDiscoveryEnabled === false ? "static" : "hybrid/discovery";
    const oneM = models.filter(model => model.supports1m === true).length;
    return {
      check: {
        name: "library",
        status: "ok",
        detail: `${models.length} models (${mode}${oneM ? `, ${oneM} with 1M` : ""}), id ${applied.appliedId}, fingerprint ${applied.fingerprint}`,
      },
      aliases: new Set(models.map(model => model.name as string)),
    };
  } catch (error) {
    return fail(describeError(error));
  }
}

/** Compare the applied aliases with what the saved profile would produce right now. */
async function checkProfileDrift(aliases: Set<string>): Promise<DoctorCheck> {
  try {
    const state = await buildClaudeDesktopState(loadConfig());
    const expected = state.models.filter(model => model.available).map(model => model.assignment.alias);
    const missing = expected.filter(alias => !aliases.has(alias));
    const stale = [...aliases].filter(alias => !expected.includes(alias));
    if (missing.length === 0 && stale.length === 0) {
      return { name: "profile drift", status: "ok", detail: "applied library matches the saved profile" };
    }
    return {
      name: "profile drift",
      status: "warn",
      detail: `${missing.length} route(s) missing and ${stale.length} stale alias(es) in the applied library; run: ocx claude desktop apply`,
    };
  } catch (error) {
    return { name: "profile drift", status: "warn", detail: `could not compare profile: ${describeError(error)}` };
  }
}

/** Linux only: is the optional `ocx-desktop://` handler installed and actually the default? */
function checkSyncLink(options: ClaudeDesktopCommandOptions): DoctorCheck {
  try {
    const protocol = getClaudeDesktopProtocolStatus(options.protocolOptions);
    if (protocol.status === "installed" && protocol.registered === false) {
      return { name: "sync link", status: "warn", detail: "handler file installed but not the default for ocx-desktop://; run: ocx claude desktop protocol install" };
    }
    if (protocol.status === "orphaned" || protocol.status === "missing") {
      return { name: "sync link", status: "warn", detail: `${protocol.status}; run: ocx claude desktop protocol install` };
    }
    return { name: "sync link", status: "ok", detail: protocol.status === "absent" ? "not installed (optional)" : "installed" };
  } catch (error) {
    return { name: "sync link", status: "fail", detail: describeError(error) };
  }
}

/** Probe the live gateway on the host it actually answered on (wildcard and IPv6 aware). */
async function checkGateway(): Promise<DoctorCheck> {
  try {
    const live = await findLiveProxy();
    if (!live) return { name: "gateway", status: "warn", detail: "no running proxy; start it with: ocx start" };
    const origin = `http://${probeHostname(live.hostname)}:${live.port}`;
    const response = await fetch(`${origin}/healthz`, { redirect: "error", signal: AbortSignal.timeout(3000) });
    return { name: "gateway", status: response.ok ? "ok" : "fail", detail: `${origin} answered HTTP ${response.status}` };
  } catch (error) {
    return { name: "gateway", status: "fail", detail: describeError(error) };
  }
}

/** Run every doctor check and return the results without printing, so each can be tested alone. */
export async function collectClaudeDesktopDoctor(options: ClaudeDesktopCommandOptions = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const library = checkAppliedLibrary();
  checks.push(library.check);
  if (library.aliases) checks.push(await checkProfileDrift(library.aliases));
  if (process.platform === "linux") checks.push(checkSyncLink(options));
  checks.push(await checkGateway());
  return checks;
}

/** One-shot health report: applied library, profile drift, link handler and live gateway. */
async function runDoctor(options: ClaudeDesktopCommandOptions, json: boolean): Promise<number> {
  const checks = await collectClaudeDesktopDoctor(options);
  const failed = checks.some(check => check.status === "fail");
  if (json) {
    console.log(JSON.stringify({ ok: !failed, checks }));
  } else {
    const icon = { ok: "✅", warn: "⚠️ ", fail: "❌" } as const;
    for (const check of checks) console.log(`${icon[check.status]} ${check.name}: ${check.detail}`);
  }
  return failed ? 1 : 0;
}

/** Persist `profile`, then write the applied library to Desktop under the shared library lock. */
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
  const result = await writeDesktop3pConfigAsync(
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
        if (argv.length !== 3) throw new Error("Usage: ocx claude desktop protocol dispatch <uri>");
        assertClaudeDesktopProtocolUri(argv[2]!, options.protocolOptions);
        // Any web page can open this link: collapse bursts into one sync and never fail loudly
        // for an unconfigured install (automatic mode skips instead of erroring).
        if (!claimClaudeDesktopProtocolDispatch(options.protocolOptions)) {
          console.log("Claude Desktop sync skipped: another sync was dispatched moments ago.");
          return 0;
        }
        return await runSync(options, true);
      }
      // Internal package-update hook; unlike install, it never opts an absent handler in.
      if (action === "__repair") {
        if (argv.length !== 2) throw new Error("Usage: ocx claude desktop protocol __repair");
        const result = repairClaudeDesktopProtocol(options.protocolOptions);
        console.log(`Claude Desktop protocol: ${result.status}.`);
        return 0;
      }
      if (argv.length !== 2 || !["install", "status", "uninstall"].includes(action ?? "")) {
        throw new Error("Usage: ocx claude desktop protocol <install|status|uninstall>");
      }
      const result = action === "install" ? installClaudeDesktopProtocol(options.protocolOptions)
        : action === "uninstall" ? uninstallClaudeDesktopProtocol(options.protocolOptions)
        : getClaudeDesktopProtocolStatus(options.protocolOptions);
      console.log(`Claude Desktop protocol: ${result.status}.`);
      if (result.registered === false) {
        console.log("The handler is installed but is not the default for ocx-desktop:// links; re-run: ocx claude desktop protocol install");
      }
      if (result.status === "orphaned") {
        console.log("An OCX-generated Desktop entry exists without ownership state; run install to adopt it or uninstall to remove it.");
      }
      if (result.associationRemoved) console.log("Removed the ocx-desktop:// default-handler association.");
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Claude Desktop protocol command failed");
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
      console.log("Active sessions were not restarted. Desktop may retain its current picker until it reloads configuration.");
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
