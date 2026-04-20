import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AccountRecord } from "../accounts/account-registry.js";
import type { Logger } from "../logging/logger.js";
import type { RuntimeContract, RuntimeFileRule } from "./runtime-contract.js";
import { assertPathInsideRoot, resolveAccountRuntimePaths } from "./runtime-contract.js";

export interface LoginWorkspace {
  workspaceRoot: string;
  codexHome: string;
}

export interface ExecutionWorkspace {
  accountId: string;
  accountStateRoot: string;
  codexHome: string;
  executionRoot: string;
  sessionId: string;
  workspaceRoot: string;
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

  await bootstrapCodexHome({
    accountId: null,
    accountStateRoot: null,
    codexHome,
    logger: input.logger,
    runtimeContract: null,
    sharedCodexHome: input.sharedCodexHome,
    workspaceKind: "account-add",
    workspaceRoot,
  });
  await mkdir(path.join(codexHome, "sessions"), { recursive: true });

  return { workspaceRoot, codexHome };
}

export async function prepareExecutionWorkspace(input: {
  account: AccountRecord;
  logger: Logger;
  runtimeContract: RuntimeContract;
  sharedCodexHome: string;
}): Promise<ExecutionWorkspace> {
  const sessionId = createExecutionSessionId();
  const runtimePaths = resolveAccountRuntimePaths(input.runtimeContract, input.account.id);
  const accountStateRoot = runtimePaths.accountStateDirectory;
  const workspaceRoot = path.join(runtimePaths.runtimeExecutionDirectory, sessionId);
  const codexHome = path.join(workspaceRoot, "codex-home");
  const authSourcePath = path.join(accountStateRoot, "auth.json");

  assertPathInsideRoot(workspaceRoot, input.runtimeContract.executionRoot, "executionWorkspace");
  assertPathInsideRoot(codexHome, workspaceRoot, "executionCodexHome");
  assertPathInsideRoot(accountStateRoot, input.runtimeContract.perAccountRoot, "accountStateRoot");

  input.logger.info("execution_workspace.prepare.start", {
    accountId: input.account.id,
    label: input.account.label,
    sessionId,
    workspaceRoot,
    codexHome,
    accountStateRoot,
    sharedCodexHome: input.sharedCodexHome,
  });

  if (!(await pathExists(authSourcePath))) {
    input.logger.error("execution_workspace.missing_auth", {
      accountId: input.account.id,
      authSourcePath,
    });
    throw new Error(
      `Account "${input.account.label}" has no stored auth.json; add the account again.`,
    );
  }

  await bootstrapCodexHome({
    accountId: input.account.id,
    accountStateRoot,
    codexHome,
    logger: input.logger,
    runtimeContract: input.runtimeContract,
    sharedCodexHome: input.sharedCodexHome,
    workspaceKind: "execution",
    workspaceRoot,
  });

  input.logger.info("execution_workspace.prepare.complete", {
    accountId: input.account.id,
    sessionId,
    workspaceRoot,
    codexHome,
  });

  return {
    accountId: input.account.id,
    accountStateRoot,
    codexHome,
    executionRoot: input.runtimeContract.executionRoot,
    sessionId,
    workspaceRoot,
  };
}

export async function cleanupExecutionWorkspace(input: {
  logger: Logger;
  workspace: ExecutionWorkspace;
}): Promise<void> {
  input.logger.debug("execution_workspace.cleanup.start", {
    accountId: input.workspace.accountId,
    sessionId: input.workspace.sessionId,
    workspaceRoot: input.workspace.workspaceRoot,
  });

  assertPathInsideRoot(
    input.workspace.workspaceRoot,
    input.workspace.executionRoot,
    "executionWorkspaceCleanup",
  );

  await rm(input.workspace.workspaceRoot, { force: true, recursive: true }).catch(
    (error: unknown) => {
      input.logger.warn("execution_workspace.cleanup.failed", {
        accountId: input.workspace.accountId,
        sessionId: input.workspace.sessionId,
        workspaceRoot: input.workspace.workspaceRoot,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  );

  input.logger.debug("execution_workspace.cleanup.complete", {
    accountId: input.workspace.accountId,
    sessionId: input.workspace.sessionId,
    workspaceRoot: input.workspace.workspaceRoot,
  });
}

export async function sanitizeRetainedExecutionWorkspace(input: {
  logger: Logger;
  runtimeContract: RuntimeContract;
  workspace: ExecutionWorkspace;
}): Promise<void> {
  const sensitiveRules = input.runtimeContract.fileRules.filter(
    (rule) => rule.classification === "account",
  );

  input.logger.warn("execution_workspace.sanitize.start", {
    accountId: input.workspace.accountId,
    sessionId: input.workspace.sessionId,
    workspaceRoot: input.workspace.workspaceRoot,
    codexHome: input.workspace.codexHome,
    sensitivePatterns: sensitiveRules.map((rule) => rule.pathPattern),
  });

  for (const rule of sensitiveRules) {
    const targetPath = resolveSanitizedRuleTarget(input.workspace.codexHome, rule);
    if (!targetPath) {
      input.logger.warn("execution_workspace.sanitize.pattern_unsupported", {
        accountId: input.workspace.accountId,
        sessionId: input.workspace.sessionId,
        pathPattern: rule.pathPattern,
        reason: "unsupported-account-pattern",
      });
      continue;
    }

    assertPathInsideRoot(targetPath, input.workspace.codexHome, "executionWorkspaceSanitize");
    input.logger.debug("execution_workspace.sanitize.removing", {
      accountId: input.workspace.accountId,
      sessionId: input.workspace.sessionId,
      pathPattern: rule.pathPattern,
      targetPath,
    });

    await rm(targetPath, { force: true, recursive: true }).catch((error: unknown) => {
      input.logger.warn("execution_workspace.sanitize.failed", {
        accountId: input.workspace.accountId,
        sessionId: input.workspace.sessionId,
        pathPattern: rule.pathPattern,
        targetPath,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  input.logger.warn("execution_workspace.sanitize.complete", {
    accountId: input.workspace.accountId,
    sessionId: input.workspace.sessionId,
    workspaceRoot: input.workspace.workspaceRoot,
    codexHome: input.workspace.codexHome,
  });
}

async function bootstrapCodexHome(input: {
  accountId: string | null;
  accountStateRoot: string | null;
  codexHome: string;
  logger: Logger;
  runtimeContract: RuntimeContract | null;
  sharedCodexHome: string;
  workspaceKind: "account-add" | "execution";
  workspaceRoot: string;
}): Promise<void> {
  await mkdir(input.codexHome, { recursive: true });
  input.logger.info("workspace_bootstrap.start", {
    accountId: input.accountId,
    workspaceKind: input.workspaceKind,
    workspaceRoot: input.workspaceRoot,
    codexHome: input.codexHome,
    sharedCodexHome: input.sharedCodexHome,
  });

  await ensurePinnedFileConfig({
    codexHome: input.codexHome,
    logger: input.logger,
    sharedCodexHome: input.sharedCodexHome,
  });
  await copySharedArtifactIfPresent({
    artifactName: "mcp.json",
    codexHome: input.codexHome,
    logger: input.logger,
    sharedCodexHome: input.sharedCodexHome,
  });
  await copySharedDirectoryIfPresent({
    artifactName: "trust",
    codexHome: input.codexHome,
    logger: input.logger,
    sharedCodexHome: input.sharedCodexHome,
  });

  if (input.runtimeContract && input.accountStateRoot && input.accountId) {
    await copyAccountScopedAuthArtifacts({
      accountId: input.accountId,
      destinationRoot: input.codexHome,
      logger: input.logger,
      runtimeContract: input.runtimeContract,
      sourceCodexHome: input.accountStateRoot,
    });
  }

  await mkdir(path.join(input.codexHome, "sessions"), { recursive: true });

  input.logger.info("workspace_bootstrap.complete", {
    accountId: input.accountId,
    workspaceKind: input.workspaceKind,
    workspaceRoot: input.workspaceRoot,
    codexHome: input.codexHome,
  });
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

function resolveSanitizedRuleTarget(codexHome: string, rule: RuntimeFileRule): string | null {
  if (rule.pathPattern.endsWith("/**")) {
    return path.join(codexHome, rule.pathPattern.slice(0, -3));
  }

  if (rule.pathPattern.includes("*")) {
    return null;
  }

  return path.join(codexHome, rule.pathPattern);
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

function createExecutionSessionId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
}
