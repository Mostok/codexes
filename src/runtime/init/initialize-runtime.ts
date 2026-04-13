import os from "node:os";
import path from "node:path";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import type { Logger } from "../../logging/logger.js";
import type { ResolvedPaths } from "../../core/paths.js";
import { createAccountRegistry } from "../../accounts/account-registry.js";

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
  const firstRun = !(await pathExists(input.paths.sharedCodexHome));
  const createdDirectories: string[] = [];
  const createdFiles: string[] = [];
  const copiedSharedArtifacts: string[] = [];
  const skippedArtifacts: RuntimeInitializationResult["skippedArtifacts"] = [];

  input.logger.info("runtime_init.start", {
    dataRoot: input.paths.dataRoot,
    sharedCodexHome: input.paths.sharedCodexHome,
    legacyCodexHome,
    firstRun,
  });

  for (const directory of [
    input.paths.dataRoot,
    input.paths.sharedCodexHome,
    input.paths.accountRoot,
    input.paths.runtimeRoot,
    path.join(input.paths.runtimeRoot, "backups"),
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

  const configResult = await ensureSharedConfigToml({
    legacyCodexHome,
    logger: input.logger,
    sharedCodexHome: input.paths.sharedCodexHome,
  });
  createdFiles.push(...configResult.createdFiles);
  copiedSharedArtifacts.push(...configResult.copiedArtifacts);
  skippedArtifacts.push(...configResult.skippedArtifacts);

  const mcpResult = await ensureSharedFileCopy({
    artifactName: "mcp.json",
    logger: input.logger,
    sharedCodexHome: input.paths.sharedCodexHome,
    sourceCodexHome: legacyCodexHome,
  });
  createdFiles.push(...mcpResult.createdFiles);
  copiedSharedArtifacts.push(...mcpResult.copiedArtifacts);
  skippedArtifacts.push(...mcpResult.skippedArtifacts);

  const trustResult = await ensureSharedDirectoryCopy({
    artifactName: "trust",
    logger: input.logger,
    sharedCodexHome: input.paths.sharedCodexHome,
    sourceCodexHome: legacyCodexHome,
  });
  copiedSharedArtifacts.push(...trustResult.copiedArtifacts);
  skippedArtifacts.push(...trustResult.skippedArtifacts);

  // Registry creation is part of first-run runtime setup but must not create account auth state.
  const registry = createAccountRegistry({
    accountRoot: input.paths.accountRoot,
    logger: input.logger,
    registryFile: input.paths.registryFile,
  });
  if (!(await pathExists(input.paths.registryFile))) {
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
    copiedSharedArtifacts,
    skippedArtifacts,
  };

  input.logger.info("runtime_init.complete", {
    firstRun: result.firstRun,
    createdDirectories: result.createdDirectories,
    createdFiles: result.createdFiles,
    copiedSharedArtifacts: result.copiedSharedArtifacts,
    skippedArtifacts: result.skippedArtifacts,
  });

  return result;
}

async function ensureSharedConfigToml(input: {
  legacyCodexHome: string;
  logger: Logger;
  sharedCodexHome: string;
}): Promise<SharedArtifactResult> {
  const targetPath = path.join(input.sharedCodexHome, "config.toml");
  const sourcePath = path.join(input.legacyCodexHome, "config.toml");

  if (await pathExists(targetPath)) {
    const existingConfig = await readFile(targetPath, "utf8");
    const existingMode = detectCredentialStoreMode(existingConfig);

    input.logger.debug("runtime_init.config_exists", {
      targetPath,
      credentialStoreMode: existingMode,
    });

    if (existingMode === "missing") {
      await writeFile(targetPath, pinFileCredentialStore(existingConfig), "utf8");
      input.logger.info("runtime_init.config_file_mode_pinned", {
        targetPath,
      });
    } else if (existingMode !== "file") {
      input.logger.warn("runtime_init.config_mode_unsupported", {
        targetPath,
        credentialStoreMode: existingMode,
      });
    }

    return emptyArtifactResult();
  }

  if (await pathExists(sourcePath) && !samePath(sourcePath, targetPath)) {
    const sourceConfig = await readFile(sourcePath, "utf8");
    const pinnedConfig = pinFileCredentialStore(sourceConfig);
    await writeFile(targetPath, pinnedConfig, "utf8");

    input.logger.info("runtime_init.config_imported", {
      sourcePath,
      targetPath,
      sourceCredentialStoreMode: detectCredentialStoreMode(sourceConfig),
      targetCredentialStoreMode: detectCredentialStoreMode(pinnedConfig),
    });

    return {
      copiedArtifacts: ["config.toml"],
      createdFiles: [targetPath],
      skippedArtifacts: [],
    };
  }

  await writeFile(
    targetPath,
    [
      "cli_auth_credentials_store = \"file\"",
      "",
      "# Wrapper-owned shared Codex home for codexes.",
      "# Add MCP and trust configuration here as needed.",
      "",
    ].join("\n"),
    "utf8",
  );
  input.logger.info("runtime_init.config_created", {
    targetPath,
  });

  return {
    copiedArtifacts: [],
    createdFiles: [targetPath],
    skippedArtifacts: [],
  };
}

async function ensureSharedFileCopy(input: {
  artifactName: string;
  logger: Logger;
  sharedCodexHome: string;
  sourceCodexHome: string;
}): Promise<SharedArtifactResult> {
  const targetPath = path.join(input.sharedCodexHome, input.artifactName);
  const sourcePath = path.join(input.sourceCodexHome, input.artifactName);

  if (await pathExists(targetPath)) {
    input.logger.debug("runtime_init.file_exists", {
      artifactName: input.artifactName,
      targetPath,
    });
    return emptyArtifactResult();
  }

  if (!(await pathExists(sourcePath)) || samePath(sourcePath, targetPath)) {
    input.logger.debug("runtime_init.file_skip", {
      artifactName: input.artifactName,
      sourcePath,
      targetPath,
      reason: "source_missing_or_same_path",
    });
    return {
      copiedArtifacts: [],
      createdFiles: [],
      skippedArtifacts: [
        {
          path: input.artifactName,
          reason: "source_missing_or_same_path",
        },
      ],
    };
  }

  await copyFile(sourcePath, targetPath);
  input.logger.info("runtime_init.file_copied", {
    artifactName: input.artifactName,
    sourcePath,
    targetPath,
  });

  return {
    copiedArtifacts: [input.artifactName],
    createdFiles: [targetPath],
    skippedArtifacts: [],
  };
}

async function ensureSharedDirectoryCopy(input: {
  artifactName: string;
  logger: Logger;
  sharedCodexHome: string;
  sourceCodexHome: string;
}): Promise<SharedArtifactResult> {
  const targetPath = path.join(input.sharedCodexHome, input.artifactName);
  const sourcePath = path.join(input.sourceCodexHome, input.artifactName);

  if (await pathExists(targetPath)) {
    input.logger.debug("runtime_init.directory_artifact_exists", {
      artifactName: input.artifactName,
      targetPath,
    });
    return emptyArtifactResult();
  }

  if (!(await pathExists(sourcePath)) || samePath(sourcePath, targetPath)) {
    input.logger.debug("runtime_init.directory_artifact_skip", {
      artifactName: input.artifactName,
      sourcePath,
      targetPath,
      reason: "source_missing_or_same_path",
    });
    return {
      copiedArtifacts: [],
      createdFiles: [],
      skippedArtifacts: [
        {
          path: input.artifactName,
          reason: "source_missing_or_same_path",
        },
      ],
    };
  }

  await cp(sourcePath, targetPath, { recursive: true });
  input.logger.info("runtime_init.directory_artifact_copied", {
    artifactName: input.artifactName,
    sourcePath,
    targetPath,
  });

  return {
    copiedArtifacts: [input.artifactName],
    createdFiles: [],
    skippedArtifacts: [],
  };
}

function detectCredentialStoreMode(rawConfig: string): string {
  const match = rawConfig.match(/^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"/m);
  return match?.[1]?.trim().toLowerCase() ?? "missing";
}

function pinFileCredentialStore(rawConfig: string): string {
  if (/^\s*cli_auth_credentials_store\s*=\s*"file"/m.test(rawConfig)) {
    return rawConfig;
  }

  if (/^\s*cli_auth_credentials_store\s*=\s*"[^"]+"/m.test(rawConfig)) {
    return rawConfig.replace(
      /^\s*cli_auth_credentials_store\s*=\s*"[^"]+"/m,
      'cli_auth_credentials_store = "file"',
    );
  }

  const trimmed = rawConfig.trim();
  if (!trimmed) {
    return 'cli_auth_credentials_store = "file"\n';
  }

  return ['cli_auth_credentials_store = "file"', "", trimmed, ""].join("\n");
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

interface SharedArtifactResult {
  copiedArtifacts: string[];
  createdFiles: string[];
  skippedArtifacts: Array<{
    path: string;
    reason: string;
  }>;
}

function emptyArtifactResult(): SharedArtifactResult {
  return {
    copiedArtifacts: [],
    createdFiles: [],
    skippedArtifacts: [],
  };
}
