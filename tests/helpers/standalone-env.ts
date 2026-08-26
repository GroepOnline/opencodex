import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./isolated-codex-home";

/**
 * PATH for tests that must stop PATH-based codex discovery while keeping shell
 * utilities reachable for any fake launcher scripts. `PATH = ""` used to work by
 * accident on Bun 1.3.14; Bun 1.4 passes the empty value through faithfully.
 * "/usr/bin:/bin" keeps utilities reachable and contains no `codex`.
 */
export const NO_CODEX_PATH = "/usr/bin:/bin";

export interface StandaloneRuntimeEnv {
  opencodexHome: string;
  codexHome: IsolatedCodexHome;
  restore(): void;
}

export function installStandaloneRuntimeEnv(prefix = "ocx-standalone-"): StandaloneRuntimeEnv {
  const previousPath = process.env.PATH;
  const previousCodexCliPath = process.env.CODEX_CLI_PATH;
  const previousOpencodexHome = process.env.OPENCODEX_HOME;

  const codexHome = installIsolatedCodexHome(`${prefix}codex-`);
  const opencodexHome = mkdtempSync(join(tmpdir(), `${prefix}home-`));

  process.env.PATH = NO_CODEX_PATH;
  delete process.env.CODEX_CLI_PATH;
  process.env.OPENCODEX_HOME = opencodexHome;

  return {
    opencodexHome,
    codexHome,
    restore() {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previousCodexCliPath;
      if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpencodexHome;
      codexHome.restore();
      rmSync(opencodexHome, { recursive: true, force: true });
    },
  };
}
