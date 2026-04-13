import { copyFile, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logging/logger.js";
import type { RuntimeContract, RuntimeFileRule } from "./runtime-contract.js";

export interface LoginWorkspace {
  workspaceRoot: string;
  codexHome: string;
}

export async function prepareLoginWorkspace(input: {
  logger: Logger;
  runtimeRoot: string;
  sharedCodexHome: string;
}): Promise<LoginWorkspace> {
  const workspaceParent = path.join(input.runtimeRoot, "tmp");
  await mkdir(workspaceParent, { recursive: true });
  const workspaceRoot = await mkdtemp(path.join(workspaceParent, "account-add-"));
  const codexHome = path.join(workspaceRoot, "codex-home");

  await mkdir(codexHome, { recursive: true });
  input.logger.info("login_workspace.created", {
    workspaceRoot,
    codexHome,
    sharedCodexHome: input.sharedCodexHome,
  });

  await ensurePinnedFileConfig({
    codexHome,
    logger: input.logger,
    sharedCodexHome: input.sharedCodexHome,
  });
  await copySharedArtifactIfPresent({
    artifactName: "mcp.json",
    codexHome,
    logger: input.logger,
    sharedCodexHome: input.sharedCodexHome,
  });
  await copySharedDirectoryIfPresent({
    artifactName: "trust",
    codexHome,
    logger: input.logger,
    sharedCodexHome: input.sharedCodexHome,
  });
  await mkdir(path.join(codexHome, "sessions"), { recursive: true });

  return { workspaceRoot, codexHome };
}

export async function copyAccountScopedAuthArtifacts(input: {
  accountId: string;
  destinationRoot: string;
  logger: Logger;
  runtimeContract: RuntimeContract;
  sourceCodexHome: string;
}): Promise<void> {
  const accountRules = input.runtimeContract.fileRules.filter(
    (rule) => rule.classification === "account",
  );

  input.logger.info("login_workspace.copy_account_artifacts.start", {
    accountId: input.accountId,
    destinationRoot: input.destinationRoot,
    sourceCodexHome: input.sourceCodexHome,
    allowedPatterns: accountRules.map((rule) => rule.pathPattern),
  });

  await mkdir(input.destinationRoot, { recursive: true });

  for (const rule of accountRules) {
    await copyRuleArtifacts({
      destinationRoot: input.destinationRoot,
      logger: input.logger,
      rule,
      sourceCodexHome: input.sourceCodexHome,
    });
  }

  input.logger.info("login_workspace.copy_account_artifacts.complete", {
    accountId: input.accountId,
    destinationRoot: input.destinationRoot,
  });
}

async function ensurePinnedFileConfig(input: {
  codexHome: string;
  logger: Logger;
  sharedCodexHome: string;
}): Promise<void> {
  const sourceConfigPath = path.join(input.sharedCodexHome, "config.toml");
  const targetConfigPath = path.join(input.codexHome, "config.toml");
  const configContents = await readFile(sourceConfigPath, "utf8").catch(() => "");
  const pinnedConfig = pinFileCredentialStore(configContents);

  await writeFile(targetConfigPath, pinnedConfig, "utf8");
  input.logger.info("login_workspace.config_prepared", {
    sourceConfigPath,
    targetConfigPath,
    credentialStoreMode: "file",
  });
}

async function copySharedArtifactIfPresent(input: {
  artifactName: string;
  codexHome: string;
  logger: Logger;
  sharedCodexHome: string;
}): Promise<void> {
  const sourcePath = path.join(input.sharedCodexHome, input.artifactName);
  const targetPath = path.join(input.codexHome, input.artifactName);

  if (!(await pathExists(sourcePath))) {
    input.logger.debug("login_workspace.shared_file_skipped", {
      artifactName: input.artifactName,
      sourcePath,
      reason: "missing",
    });
    return;
  }

  await copyFile(sourcePath, targetPath);
  input.logger.debug("login_workspace.shared_file_copied", {
    artifactName: input.artifactName,
    sourcePath,
    targetPath,
  });
}

async function copySharedDirectoryIfPresent(input: {
  artifactName: string;
  codexHome: string;
  logger: Logger;
  sharedCodexHome: string;
}): Promise<void> {
  const sourcePath = path.join(input.sharedCodexHome, input.artifactName);
  const targetPath = path.join(input.codexHome, input.artifactName);

  if (!(await pathExists(sourcePath))) {
    input.logger.debug("login_workspace.shared_directory_skipped", {
      artifactName: input.artifactName,
      sourcePath,
      reason: "missing",
    });
    return;
  }

  await cp(sourcePath, targetPath, { recursive: true });
  input.logger.debug("login_workspace.shared_directory_copied", {
    artifactName: input.artifactName,
    sourcePath,
    targetPath,
  });
}

async function copyRuleArtifacts(input: {
  destinationRoot: string;
  logger: Logger;
  rule: RuntimeFileRule;
  sourceCodexHome: string;
}): Promise<void> {
  if (input.rule.pathPattern.endsWith("/**")) {
    const relativeDirectory = input.rule.pathPattern.slice(0, -3);
    const sourceDirectory = path.join(input.sourceCodexHome, relativeDirectory);
    const targetDirectory = path.join(input.destinationRoot, relativeDirectory);

    if (!(await pathExists(sourceDirectory))) {
      input.logger.debug("login_workspace.account_directory_skipped", {
        pathPattern: input.rule.pathPattern,
        sourceDirectory,
        reason: "missing",
      });
      return;
    }

    await cp(sourceDirectory, targetDirectory, { recursive: true });
    input.logger.debug("login_workspace.account_directory_copied", {
      pathPattern: input.rule.pathPattern,
      sourceDirectory,
      targetDirectory,
    });
    return;
  }

  const sourceFile = path.join(input.sourceCodexHome, input.rule.pathPattern);
  const targetFile = path.join(input.destinationRoot, input.rule.pathPattern);

  if (!(await pathExists(sourceFile))) {
    input.logger.debug("login_workspace.account_file_skipped", {
      pathPattern: input.rule.pathPattern,
      sourceFile,
      reason: "missing",
    });
    return;
  }

  await mkdir(path.dirname(targetFile), { recursive: true });
  await copyFile(sourceFile, targetFile);
  input.logger.debug("login_workspace.account_file_copied", {
    pathPattern: input.rule.pathPattern,
    sourceFile,
    targetFile,
  });
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
