import { copyFile, cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AccountRecord } from "../../accounts/account-registry.js";
import type { Logger } from "../../logging/logger.js";
import type { RuntimeContract, RuntimeFileRule } from "../runtime-contract.js";
import { resolveAccountRuntimePaths } from "../runtime-contract.js";
import type { ExecutionWorkspace } from "../login-workspace.js";

export interface ActivatedAccountSession {
  account: AccountRecord;
  backupRoot: string;
  runtimeContract: RuntimeContract;
  sharedCodexHome: string;
  sourceAccountStateRoot: string;
}

export async function activateAccountIntoSharedRuntime(input: {
  account: AccountRecord;
  logger: Logger;
  runtimeContract: RuntimeContract;
  sharedCodexHome: string;
}): Promise<ActivatedAccountSession> {
  const runtimePaths = resolveAccountRuntimePaths(input.runtimeContract, input.account.id);
  const accountStateRoot = runtimePaths.accountStateDirectory;
  const backupRoot = path.join(runtimePaths.runtimeBackupDirectory, "active");

  input.logger.info("account_activation.start", {
    accountId: input.account.id,
    label: input.account.label,
    accountStateRoot,
    sharedCodexHome: input.sharedCodexHome,
    backupRoot,
  });

  await rm(backupRoot, { force: true, recursive: true }).catch(() => undefined);
  await mkdir(backupRoot, { recursive: true });

  const accountRules = input.runtimeContract.fileRules.filter(
    (rule) => rule.classification === "account",
  );
  const authSourcePath = path.join(accountStateRoot, "auth.json");
  if (!(await pathExists(authSourcePath))) {
    input.logger.error("account_activation.missing_auth", {
      accountId: input.account.id,
      authSourcePath,
    });
    throw new Error(
      `Account "${input.account.label}" has no stored auth.json; add the account again.`,
    );
  }

  try {
    for (const rule of accountRules) {
      await backupRuntimeArtifact({
        backupRoot,
        logger: input.logger,
        rule,
        sharedCodexHome: input.sharedCodexHome,
      });
      await replaceRuntimeArtifact({
        accountStateRoot,
        logger: input.logger,
        rule,
        sharedCodexHome: input.sharedCodexHome,
      });
    }
  } catch (error) {
    input.logger.error("account_activation.failed", {
      accountId: input.account.id,
      message: error instanceof Error ? error.message : String(error),
    });
    await restoreSharedRuntimeFromBackup({
      account: input.account,
      backupRoot,
      logger: input.logger,
      runtimeContract: input.runtimeContract,
      sharedCodexHome: input.sharedCodexHome,
    });
    throw error;
  }

  input.logger.info("account_activation.complete", {
    accountId: input.account.id,
    sharedCodexHome: input.sharedCodexHome,
  });

  return {
    account: input.account,
    backupRoot,
    runtimeContract: input.runtimeContract,
    sharedCodexHome: input.sharedCodexHome,
    sourceAccountStateRoot: accountStateRoot,
  };
}

export async function syncSharedRuntimeBackToAccount(input: {
  logger: Logger;
  session: ActivatedAccountSession;
}): Promise<void> {
  const accountRules = input.session.runtimeContract.fileRules.filter(
    (rule) => rule.classification === "account",
  );

  input.logger.info("account_sync.start", {
    accountId: input.session.account.id,
    sharedCodexHome: input.session.sharedCodexHome,
    accountStateRoot: input.session.sourceAccountStateRoot,
  });

  for (const rule of accountRules) {
    await syncRuntimeArtifact({
      accountStateRoot: input.session.sourceAccountStateRoot,
      logger: input.logger,
      rule,
      sharedCodexHome: input.session.sharedCodexHome,
    });
  }

  input.logger.info("account_sync.complete", {
    accountId: input.session.account.id,
  });
}

export async function syncExecutionWorkspaceBackToAccount(input: {
  account: AccountRecord;
  logger: Logger;
  runtimeContract: RuntimeContract;
  workspace: ExecutionWorkspace;
}): Promise<void> {
  const accountRules = input.runtimeContract.fileRules.filter(
    (rule) => rule.classification === "account" && rule.syncBack === "if-changed",
  );

  input.logger.info("execution_workspace_sync.start", {
    accountId: input.account.id,
    label: input.account.label,
    sessionId: input.workspace.sessionId,
    workspaceCodexHome: input.workspace.codexHome,
    accountStateRoot: input.workspace.accountStateRoot,
    allowedPatterns: accountRules.map((rule) => rule.pathPattern),
  });

  for (const rule of accountRules) {
    await syncRuntimeArtifact({
      accountStateRoot: input.workspace.accountStateRoot,
      logger: input.logger,
      rule,
      sharedCodexHome: input.workspace.codexHome,
    });
  }

  input.logger.info("execution_workspace_sync.complete", {
    accountId: input.account.id,
    sessionId: input.workspace.sessionId,
  });
}

export async function syncExecutionWorkspaceBackToSharedHome(input: {
  allowedPathPatterns?: readonly string[];
  logger: Logger;
  runtimeContract: RuntimeContract;
  sharedCodexHome: string;
  workspace: ExecutionWorkspace;
}): Promise<void> {
  const sharedRules = input.runtimeContract.fileRules.filter(
    (rule) =>
      rule.classification === "shared" &&
      rule.syncBack === "if-changed" &&
      (!input.allowedPathPatterns || input.allowedPathPatterns.includes(rule.pathPattern)),
  );

  input.logger.info("execution_workspace_shared_sync.start", {
    accountId: input.workspace.accountId,
    sessionId: input.workspace.sessionId,
    workspaceCodexHome: input.workspace.codexHome,
    sharedCodexHome: input.sharedCodexHome,
    allowedPatterns: sharedRules.map((rule) => rule.pathPattern),
  });

  for (const rule of sharedRules) {
    await syncRuntimeArtifact({
      accountStateRoot: input.sharedCodexHome,
      logger: input.logger,
      rule,
      sharedCodexHome: input.workspace.codexHome,
    });
  }

  input.logger.info("execution_workspace_shared_sync.complete", {
    accountId: input.workspace.accountId,
    sessionId: input.workspace.sessionId,
  });
}

export async function restoreSharedRuntimeFromBackup(input: {
  account: AccountRecord;
  backupRoot: string;
  logger: Logger;
  runtimeContract: RuntimeContract;
  sharedCodexHome: string;
}): Promise<void> {
  const accountRules = input.runtimeContract.fileRules.filter(
    (rule) => rule.classification === "account",
  );

  input.logger.warn("account_activation.restore.start", {
    accountId: input.account.id,
    backupRoot: input.backupRoot,
    sharedCodexHome: input.sharedCodexHome,
  });

  for (const rule of accountRules) {
    await restoreRuntimeArtifact({
      backupRoot: input.backupRoot,
      logger: input.logger,
      rule,
      sharedCodexHome: input.sharedCodexHome,
    });
  }

  input.logger.warn("account_activation.restore.complete", {
    accountId: input.account.id,
  });
}

async function backupRuntimeArtifact(input: {
  backupRoot: string;
  logger: Logger;
  rule: RuntimeFileRule;
  sharedCodexHome: string;
}): Promise<void> {
  const sourcePath = path.join(input.sharedCodexHome, normalizedPattern(input.rule.pathPattern));
  const backupPath = path.join(input.backupRoot, normalizedPattern(input.rule.pathPattern));

  if (!(await pathExists(sourcePath))) {
    input.logger.debug("account_activation.backup.skip", {
      pathPattern: input.rule.pathPattern,
      sourcePath,
      reason: "missing",
    });
    return;
  }

  await mkdir(path.dirname(backupPath), { recursive: true });
  if (isDirectoryPattern(input.rule)) {
    await cp(sourcePath, backupPath, { recursive: true });
  } else {
    await copyFile(sourcePath, backupPath);
  }

  input.logger.debug("account_activation.backup.complete", {
    pathPattern: input.rule.pathPattern,
    sourcePath,
    backupPath,
  });
}

async function replaceRuntimeArtifact(input: {
  accountStateRoot: string;
  logger: Logger;
  rule: RuntimeFileRule;
  sharedCodexHome: string;
}): Promise<void> {
  const sourcePath = path.join(input.accountStateRoot, normalizedPattern(input.rule.pathPattern));
  const targetPath = path.join(input.sharedCodexHome, normalizedPattern(input.rule.pathPattern));

  await rm(targetPath, { force: true, recursive: true }).catch(() => undefined);
  if (!(await pathExists(sourcePath))) {
    input.logger.debug("account_activation.replace.skip", {
      pathPattern: input.rule.pathPattern,
      sourcePath,
      reason: "missing",
    });
    return;
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  if (isDirectoryPattern(input.rule)) {
    await cp(sourcePath, targetPath, { recursive: true });
  } else {
    await copyFile(sourcePath, targetPath);
  }

  input.logger.debug("account_activation.replace.complete", {
    pathPattern: input.rule.pathPattern,
    sourcePath,
    targetPath,
  });
}

async function syncRuntimeArtifact(input: {
  accountStateRoot: string;
  logger: Logger;
  rule: RuntimeFileRule;
  sharedCodexHome: string;
}): Promise<void> {
  const sourcePath = path.join(input.sharedCodexHome, normalizedPattern(input.rule.pathPattern));
  const targetPath = path.join(input.accountStateRoot, normalizedPattern(input.rule.pathPattern));

  if (!(await pathExists(sourcePath))) {
    input.logger.debug("account_sync.skip", {
      pathPattern: input.rule.pathPattern,
      sourcePath,
      reason: "missing",
    });
    return;
  }

  const changed = await hasArtifactChanged(sourcePath, targetPath, isDirectoryPattern(input.rule));
  if (!changed) {
    input.logger.debug("account_sync.no_change", {
      pathPattern: input.rule.pathPattern,
      sourcePath,
      targetPath,
    });
    return;
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    if (isDirectoryPattern(input.rule)) {
      await mkdir(targetPath, { recursive: true });
      await cp(sourcePath, targetPath, { force: true, recursive: true });
      input.logger.info("account_sync.directory_merged", {
        pathPattern: input.rule.pathPattern,
        sourcePath,
        targetPath,
        policy: "merge-without-delete",
      });
    } else {
      await rm(targetPath, { force: true, recursive: true }).catch(() => undefined);
      await copyFile(sourcePath, targetPath);
    }
  } catch (error) {
    if (isBestEffortSyncError(error)) {
      input.logger.warn("account_sync.best_effort_skip", {
        pathPattern: input.rule.pathPattern,
        sourcePath,
        targetPath,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    throw error;
  }

  input.logger.info("account_sync.updated", {
    pathPattern: input.rule.pathPattern,
    sourcePath,
    targetPath,
  });
}

async function restoreRuntimeArtifact(input: {
  backupRoot: string;
  logger: Logger;
  rule: RuntimeFileRule;
  sharedCodexHome: string;
}): Promise<void> {
  const backupPath = path.join(input.backupRoot, normalizedPattern(input.rule.pathPattern));
  const targetPath = path.join(input.sharedCodexHome, normalizedPattern(input.rule.pathPattern));

  await rm(targetPath, { force: true, recursive: true }).catch(() => undefined);

  if (!(await pathExists(backupPath))) {
    input.logger.debug("account_activation.restore.skip", {
      pathPattern: input.rule.pathPattern,
      backupPath,
      reason: "missing",
    });
    return;
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  if (isDirectoryPattern(input.rule)) {
    await cp(backupPath, targetPath, { recursive: true });
  } else {
    await copyFile(backupPath, targetPath);
  }

  input.logger.debug("account_activation.restore.complete_artifact", {
    pathPattern: input.rule.pathPattern,
    backupPath,
    targetPath,
  });
}

function isDirectoryPattern(rule: RuntimeFileRule): boolean {
  return rule.pathPattern.endsWith("/**");
}

function normalizedPattern(pattern: string): string {
  return pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
}

function isBestEffortSyncError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return error.code === "EBUSY" || error.code === "EPERM";
}

async function hasArtifactChanged(
  sourcePath: string,
  targetPath: string,
  isDirectory: boolean,
): Promise<boolean> {
  if (!(await pathExists(targetPath))) {
    return true;
  }

  if (isDirectory) {
    const [sourceHash, targetHash] = await Promise.all([
      hashDirectory(sourcePath),
      hashDirectory(targetPath),
    ]);
    return sourceHash !== targetHash;
  }

  const [sourceHash, targetHash] = await Promise.all([
    hashFile(sourcePath),
    hashFile(targetPath),
  ]);
  return sourceHash !== targetHash;
}

async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function hashDirectory(directoryPath: string): Promise<string> {
  const entries = await collectFiles(directoryPath);
  const hash = createHash("sha256");

  for (const entry of entries.sort()) {
    hash.update(entry.relativePath);
    hash.update(await readFile(entry.absolutePath));
  }

  return hash.digest("hex");
}

async function collectFiles(root: string): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const rootStats = await stat(root).catch(() => null);
  if (!rootStats) {
    return [];
  }

  if (!rootStats.isDirectory()) {
    return [{ absolutePath: root, relativePath: path.basename(root) }];
  }

  const results: Array<{ absolutePath: string; relativePath: string }> = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(current, { withFileTypes: true }),
    );
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        results.push({
          absolutePath,
          relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
        });
      }
    }
  }

  return results;
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
