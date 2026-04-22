import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Logger } from "../../logging/logger.js";
import type { ResolvedPaths } from "../../core/paths.js";
import { createAccountRegistry } from "../../accounts/account-registry.js";
import { pathExists } from "../link-utils.js";

export interface RuntimeInitializationResult {
  firstRun: boolean;
  legacyCodexHome: string;
  sharedCodexHome: string;
  createdDirectories: string[];
  createdFiles: string[];
  copiedSharedArtifacts: string[];
  skippedArtifacts: Array<{
    path: string;
    reason: string;
  }>;
}

export async function initializeRuntimeEnvironment(input: {
  env: NodeJS.ProcessEnv;
  logger: Logger;
  paths: ResolvedPaths;
}): Promise<RuntimeInitializationResult> {
  const legacyCodexHome = path.join(os.homedir(), ".codex");
  const firstRun = !(await pathExists(input.paths.registryFile));
  const createdDirectories: string[] = [];
  const createdFiles: string[] = [];
  const skippedArtifacts: RuntimeInitializationResult["skippedArtifacts"] = [];

  input.logger.debug("runtime_init.path_model", {
    dataRoot: input.paths.dataRoot,
    liveCodexHome: input.paths.sharedCodexHome,
    legacyCodexHome,
    sharedHomeDisabled: true,
  });

  input.logger.info("runtime_init.start", {
    dataRoot: input.paths.dataRoot,
    projectRoot: input.paths.projectRoot,
    liveCodexHome: input.paths.sharedCodexHome,
    legacyCodexHome,
    firstRun,
  });

  for (const directory of [
    input.paths.dataRoot,
    input.paths.accountRoot,
    input.paths.runtimeRoot,
    path.join(input.paths.runtimeRoot, "backups"),
    input.paths.executionRoot,
    path.join(input.paths.runtimeRoot, "tmp"),
    path.dirname(input.paths.registryFile),
  ]) {
    if (!(await pathExists(directory))) {
      createdDirectories.push(directory);
      input.logger.info("runtime_init.directory_create", { directory });
    } else {
      input.logger.debug("runtime_init.directory_exists", { directory });
    }

    await mkdir(directory, { recursive: true });
  }

  if (!(await pathExists(input.paths.sharedCodexHome))) {
    skippedArtifacts.push({
      path: input.paths.sharedCodexHome,
      reason: "live_codex_home_missing",
    });
    input.logger.warn("runtime_init.live_codex_home_missing", {
      liveCodexHome: input.paths.sharedCodexHome,
    });
  } else {
    input.logger.debug("runtime_init.live_codex_home_ready", {
      liveCodexHome: input.paths.sharedCodexHome,
    });
  }

  const registry = createAccountRegistry({
    accountRoot: input.paths.accountRoot,
    logger: input.logger,
    registryFile: input.paths.registryFile,
  });
  if (!(await pathExists(input.paths.registryFile))) {
    await mkdir(path.dirname(input.paths.registryFile), { recursive: true });
    await writeFile(
      input.paths.registryFile,
      JSON.stringify({ schemaVersion: 1, accounts: [] }, null, 2),
      "utf8",
    );
    createdFiles.push(input.paths.registryFile);
    input.logger.info("runtime_init.registry_bootstrap", {
      registryFile: input.paths.registryFile,
    });
  } else {
    input.logger.debug("runtime_init.registry_exists", {
      registryFile: input.paths.registryFile,
    });
  }
  await registry.listAccounts();

  const result: RuntimeInitializationResult = {
    firstRun,
    legacyCodexHome,
    sharedCodexHome: input.paths.sharedCodexHome,
    createdDirectories,
    createdFiles,
    copiedSharedArtifacts: [],
    skippedArtifacts,
  };

  input.logger.info("runtime_init.complete", {
    firstRun: result.firstRun,
    createdDirectories: result.createdDirectories,
    createdFiles: result.createdFiles,
    liveCodexHome: result.sharedCodexHome,
    skippedArtifacts: result.skippedArtifacts,
    sharedHomeBootstrap: "disabled",
  });

  return result;
}
