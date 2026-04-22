import os from "node:os";
import path from "node:path";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
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
    projectRoot: input.paths.projectRoot,
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

  const configResult = await ensureSharedConfigToml({
    legacyCodexHome,
    logger: input.logger,
    projectRoot: input.paths.projectRoot,
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
  projectRoot: string;
  sharedCodexHome: string;
}): Promise<SharedArtifactResult> {
  const targetPath = path.join(input.sharedCodexHome, "config.toml");
  const sourcePath = path.join(input.legacyCodexHome, "config.toml");

  if (await pathExists(sourcePath) && !samePath(sourcePath, targetPath)) {
    const linkType = await ensureLiveLink({
      isDirectory: false,
      logger: input.logger,
      sourcePath,
      targetPath,
    });
    const sourceCredentialStoreMode = detectCredentialStoreMode(await readFile(sourcePath, "utf8"));

    input.logger.info("runtime_init.config_linked", {
      linkType,
      projectRoot: input.projectRoot,
      sourceCredentialStoreMode,
      sourcePath,
      targetPath,
    });

    if (sourceCredentialStoreMode !== "file") {
      input.logger.warn("runtime_init.config_mode_unsupported", {
        targetPath: sourcePath,
        credentialStoreMode: sourceCredentialStoreMode,
      });
    }

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

  const linkType = await ensureLiveLink({
    isDirectory: false,
    logger: input.logger,
    sourcePath,
    targetPath,
  });
  input.logger.info("runtime_init.file_linked", {
    artifactName: input.artifactName,
    linkType,
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

  const linkType = await ensureLiveLink({
    isDirectory: true,
    logger: input.logger,
    sourcePath,
    targetPath,
  });
  input.logger.info("runtime_init.directory_artifact_linked", {
    artifactName: input.artifactName,
    linkType,
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

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

async function ensureLiveLink(input: {
  isDirectory: boolean;
  logger: Logger;
  sourcePath: string;
  targetPath: string;
}): Promise<"file" | "hardlink" | "junction"> {
  const existingLinkTarget = await readlink(input.targetPath).catch(() => null);
  if (
    existingLinkTarget &&
    path.resolve(path.dirname(input.targetPath), existingLinkTarget) === path.resolve(input.sourcePath)
  ) {
    return input.isDirectory ? "junction" : "file";
  }

  if (!input.isDirectory && (await isSameFile(input.sourcePath, input.targetPath))) {
    input.logger.debug("runtime_init.file_hardlink_identity_valid", {
      sourcePath: input.sourcePath,
      targetPath: input.targetPath,
    });
    return "hardlink";
  }

  await rm(input.targetPath, { force: true, recursive: true }).catch(() => undefined);
  await mkdir(path.dirname(input.targetPath), { recursive: true });

  if (input.isDirectory) {
    await symlink(input.sourcePath, input.targetPath, "junction");
    return "junction";
  }

  try {
    await symlink(input.sourcePath, input.targetPath, "file");
    return "file";
  } catch (error) {
    input.logger.debug("runtime_init.file_symlink_fallback", {
      sourcePath: input.sourcePath,
      targetPath: input.targetPath,
      message: error instanceof Error ? error.message : String(error),
    });
    await link(input.sourcePath, input.targetPath);
    return "hardlink";
  }
}

async function isSameFile(sourcePath: string, targetPath: string): Promise<boolean> {
  const [sourceStats, targetStats] = await Promise.all([
    lstat(sourcePath).catch(() => null),
    lstat(targetPath).catch(() => null),
  ]);
  if (!sourceStats || !targetStats) {
    return false;
  }

  return sourceStats.dev === targetStats.dev && sourceStats.ino === targetStats.ino;
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
