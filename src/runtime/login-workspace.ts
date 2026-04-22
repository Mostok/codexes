import {
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
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
  const workspaceRoot = path.join(accountStateRoot, "codex-home");
  const codexHome = workspaceRoot;
  const authSourcePath = path.join(accountStateRoot, "auth.json");

  assertPathInsideRoot(workspaceRoot, accountStateRoot, "accountCodexHome");
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
  input.logger.debug("execution_workspace.account_home_resolved", {
    accountId: input.account.id,
    sessionId,
    accountStateRoot,
    codexHome,
    sharedCodexHome: input.sharedCodexHome,
    homeLayout: "stable-account-home-with-shared-links",
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
    reuse: true,
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
  input.logger.debug("execution_workspace.cleanup.skipped_stable_account_home", {
    accountId: input.workspace.accountId,
    sessionId: input.workspace.sessionId,
    workspaceRoot: input.workspace.workspaceRoot,
    reason: "account codex home is reused between terminals",
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

  await linkSharedCodexHomeEntries({
    codexHome: input.codexHome,
    logger: input.logger,
    runtimeContract: input.runtimeContract,
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

async function linkSharedCodexHomeEntries(input: {
  codexHome: string;
  logger: Logger;
  runtimeContract: RuntimeContract | null;
  sharedCodexHome: string;
}): Promise<void> {
  const sourceCodexHome = await resolveSharedCodexHomeLinkSource({
    fallbackSharedCodexHome: input.sharedCodexHome,
    logger: input.logger,
  });
  const entries = await readdir(sourceCodexHome, { withFileTypes: true }).catch(
    (error: unknown) => {
      input.logger.warn("login_workspace.shared_link.scan_failed", {
        sharedCodexHome: sourceCodexHome,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    },
  );

  input.logger.debug("login_workspace.shared_link.scan_complete", {
    codexHome: input.codexHome,
    sharedCodexHome: sourceCodexHome,
    entryCount: entries.length,
  });

  for (const entry of entries) {
    if (isAccountScopedEntry(entry.name, input.runtimeContract)) {
      input.logger.debug("login_workspace.shared_link.skip_auth", {
        entryName: entry.name,
        reason: "entry is account-scoped",
      });
      continue;
    }

    await ensureSharedLink({
      entryName: entry.name,
      isDirectory: entry.isDirectory(),
      logger: input.logger,
      sourcePath: path.join(sourceCodexHome, entry.name),
      targetPath: path.join(input.codexHome, entry.name),
    });
  }
}

async function resolveSharedCodexHomeLinkSource(input: {
  fallbackSharedCodexHome: string;
  logger: Logger;
}): Promise<string> {
  const legacyCodexHome = path.join(os.homedir(), ".codex");
  if (await pathExists(legacyCodexHome)) {
    input.logger.debug("login_workspace.shared_link.source_selected", {
      selectedSource: legacyCodexHome,
      fallbackSharedCodexHome: input.fallbackSharedCodexHome,
      sourceKind: "legacy-codex-home",
    });
    return legacyCodexHome;
  }

  input.logger.warn("login_workspace.shared_link.source_fallback", {
    selectedSource: input.fallbackSharedCodexHome,
    fallbackSharedCodexHome: input.fallbackSharedCodexHome,
    reason: "legacy-codex-home-missing",
  });
  return input.fallbackSharedCodexHome;
}

function isAccountScopedEntry(
  entryName: string,
  runtimeContract: RuntimeContract | null,
): boolean {
  if (!runtimeContract) {
    return entryName === "auth.json" || entryName === "sessions";
  }

  return runtimeContract.fileRules.some((rule) => {
    if (rule.classification !== "account") {
      return false;
    }

    return rule.pathPattern === entryName || rule.pathPattern.startsWith(`${entryName}/`);
  });
}

async function ensureSharedLink(input: {
  entryName: string;
  isDirectory: boolean;
  logger: Logger;
  sourcePath: string;
  targetPath: string;
}): Promise<void> {
  const existingLinkTarget = await readlink(input.targetPath).catch(() => null);
  if (existingLinkTarget && path.resolve(path.dirname(input.targetPath), existingLinkTarget) === input.sourcePath) {
    input.logger.debug("login_workspace.shared_link.exists", {
      entryName: input.entryName,
      sourcePath: input.sourcePath,
      targetPath: input.targetPath,
    });
    return;
  }
  if (!input.isDirectory && (await isSameFile(input.sourcePath, input.targetPath))) {
    input.logger.debug("login_workspace.shared_link.exists", {
      entryName: input.entryName,
      sourcePath: input.sourcePath,
      targetPath: input.targetPath,
      linkType: "hardlink",
      validation: "current-source-file-identity",
    });
    return;
  }

  await rm(input.targetPath, { force: true, recursive: true }).catch(() => undefined);
  await mkdir(path.dirname(input.targetPath), { recursive: true });
  let linkType = process.platform === "win32" && input.isDirectory ? "junction" : input.isDirectory ? "dir" : "file";
  if (input.isDirectory) {
    await symlink(input.sourcePath, input.targetPath, linkType);
  } else {
    try {
      await symlink(input.sourcePath, input.targetPath, "file");
    } catch (error) {
      linkType = "hardlink";
      input.logger.debug("login_workspace.shared_link.file_symlink_fallback", {
        entryName: input.entryName,
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        message: error instanceof Error ? error.message : String(error),
      });
      await link(input.sourcePath, input.targetPath);
    }
  }
  input.logger.debug("login_workspace.shared_link.created", {
    entryName: input.entryName,
    sourcePath: input.sourcePath,
    targetPath: input.targetPath,
    linkType,
  });
}

async function isSameFile(sourcePath: string, targetPath: string): Promise<boolean> {
  const [sourceStats, targetStats] = await Promise.all([
    lstat(sourcePath).catch(() => null),
    lstat(targetPath).catch(() => null),
  ]);
  return Boolean(
    sourceStats &&
      targetStats &&
      sourceStats.dev === targetStats.dev &&
      sourceStats.ino === targetStats.ino,
  );
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
      await rm(targetDirectory, { force: true, recursive: true }).catch(() => undefined);
      input.logger.debug("login_workspace.account_directory_cleared", {
        pathPattern: input.rule.pathPattern,
        sourceDirectory,
        targetDirectory,
        reason: "missing",
      });
      return;
    }

    await rm(targetDirectory, { force: true, recursive: true }).catch(() => undefined);
    await cp(sourceDirectory, targetDirectory, { recursive: true });
    input.logger.debug("login_workspace.account_directory_refreshed", {
      pathPattern: input.rule.pathPattern,
      sourceDirectory,
      targetDirectory,
    });
    return;
  }

  const sourceFile = path.join(input.sourceCodexHome, input.rule.pathPattern);
  const targetFile = path.join(input.destinationRoot, input.rule.pathPattern);

  if (!(await pathExists(sourceFile))) {
    await rm(targetFile, { force: true, recursive: true }).catch(() => undefined);
    input.logger.debug("login_workspace.account_file_cleared", {
      pathPattern: input.rule.pathPattern,
      sourceFile,
      targetFile,
      reason: "missing",
    });
    return;
  }

  await mkdir(path.dirname(targetFile), { recursive: true });
  await rm(targetFile, { force: true, recursive: true }).catch(() => undefined);
  await copyFile(sourceFile, targetFile);
  input.logger.debug("login_workspace.account_file_refreshed", {
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
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
