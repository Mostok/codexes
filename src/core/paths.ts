import path from "node:path";
import os from "node:os";

export interface ResolvedPaths {
  projectRoot: string;
  dataRoot: string;
  sharedCodexHome: string;
  accountRoot: string;
  executionRoot: string;
  runtimeRoot: string;
  registryFile: string;
  wrapperConfigFile: string;
  codexConfigFile: string;
  selectionCacheFile: string;
}

export function resolvePaths(
  cwd: string,
  env: NodeJS.ProcessEnv,
): ResolvedPaths {
  const baseDataDir = resolveBaseDataDir(env);
  const sharedCodexHome = resolveCodexHome(env);

  return {
    projectRoot: cwd,
    dataRoot: baseDataDir,
    sharedCodexHome,
    accountRoot: path.join(baseDataDir, "accounts"),
    runtimeRoot: path.join(baseDataDir, "runtime"),
    executionRoot: path.join(baseDataDir, "runtime", "executions"),
    registryFile: path.join(baseDataDir, "registry.json"),
    wrapperConfigFile: path.join(baseDataDir, "codexes.json"),
    codexConfigFile: path.join(sharedCodexHome, "config.toml"),
    selectionCacheFile: path.join(baseDataDir, "selection-cache.json"),
  };
}

function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function resolveBaseDataDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    return path.join(
      env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "codexes",
    );
  }

  if (process.platform === "darwin") {
    return path.join(
      env.HOME ?? os.homedir(),
      "Library",
      "Application Support",
      "codexes",
    );
  }

  const xdgStateHome = env.XDG_STATE_HOME;

  if (xdgStateHome) {
    return path.join(xdgStateHome, "codexes");
  }

  return path.join(env.HOME ?? os.homedir(), ".local", "state", "codexes");
}
