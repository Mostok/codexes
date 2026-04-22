import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AccountRecord } from "../accounts/account-registry.js";
import type { Logger } from "../logging/logger.js";
import type { RuntimeContract } from "./runtime-contract.js";
import { assertPathInsideRoot, resolveAccountRuntimePaths } from "./runtime-contract.js";
import { ensureRuntimeLink, pathExists, removePathIfExists } from "./link-utils.js";

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

  await reconcileCodexHome({
    accountId: null,
    authSourcePath: null,
    codexHome,
    logger: input.logger,
    runtimeContract: null,
    sharedCodexHome: input.sharedCodexHome,
    workspaceKind: "account-add",
    workspaceRoot,
  });

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
    homeLayout: "stable-account-home-with-direct-links",
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

  await reconcileCodexHome({
    accountId: input.account.id,
    authSourcePath,
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
    reason: "account codex home is reused between terminals and reconciled on the next launch",
  });
}

export async function sanitizeRetainedExecutionWorkspace(input: {
  logger: Logger;
  runtimeContract: RuntimeContract;
  workspace: ExecutionWorkspace;
}): Promise<void> {
  input.logger.warn("execution_workspace.sanitize.skipped", {
    accountId: input.workspace.accountId,
    sessionId: input.workspace.sessionId,
    workspaceRoot: input.workspace.workspaceRoot,
    codexHome: input.workspace.codexHome,
    reason: "workspace contains only live links plus auth.json link; next prepare pass reconciles drift",
    sharedPatterns: input.runtimeContract.fileRules
      .filter((rule) => rule.classification === "shared")
      .map((rule) => rule.pathPattern),
  });
}

export async function persistAccountAuthState(input: {
  accountId: string;
  destinationRoot: string;
  logger: Logger;
  sourceCodexHome: string;
}): Promise<void> {
  const sourceFile = path.join(input.sourceCodexHome, "auth.json");
  const targetFile = path.join(input.destinationRoot, "auth.json");

  input.logger.info("login_workspace.persist_account_auth.start", {
    accountId: input.accountId,
    sourceFile,
    targetFile,
  });

  if (!(await pathExists(sourceFile))) {
    input.logger.error("login_workspace.persist_account_auth.missing_source", {
      accountId: input.accountId,
      sourceFile,
    });
    throw new Error("codex login completed without creating auth.json in the login workspace.");
  }

  await mkdir(path.dirname(targetFile), { recursive: true });
  await copyFile(sourceFile, targetFile);

  input.logger.info("login_workspace.persist_account_auth.complete", {
    accountId: input.accountId,
    sourceFile,
    targetFile,
  });
}

async function reconcileCodexHome(input: {
  accountId: string | null;
  authSourcePath: string | null;
  codexHome: string;
  logger: Logger;
  runtimeContract: RuntimeContract | null;
  sharedCodexHome: string;
  workspaceKind: "account-add" | "execution";
  workspaceRoot: string;
}): Promise<void> {
  await mkdir(input.codexHome, { recursive: true });
  input.logger.info("workspace_reconcile.start", {
    accountId: input.accountId,
    workspaceKind: input.workspaceKind,
    workspaceRoot: input.workspaceRoot,
    codexHome: input.codexHome,
    sharedCodexHome: input.sharedCodexHome,
    authSourcePath: input.authSourcePath,
  });

  const summary = {
    created: 0,
    repaired: 0,
    removed: 0,
    reused: 0,
  };
  const sourceEntries = await readdir(input.sharedCodexHome, { withFileTypes: true }).catch(
    (error: unknown) => {
      input.logger.warn("workspace_reconcile.source_scan_failed", {
        accountId: input.accountId,
        workspaceKind: input.workspaceKind,
        sharedCodexHome: input.sharedCodexHome,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    },
  );
  const desiredEntryNames = new Set<string>();

  for (const entry of sourceEntries) {
    if (isAccountScopedEntry(entry.name, input.runtimeContract)) {
      input.logger.debug("workspace_reconcile.shared_entry_skipped", {
        accountId: input.accountId,
        workspaceKind: input.workspaceKind,
        entryName: entry.name,
        reason: "account-scoped entry is handled separately",
      });
      continue;
    }

    desiredEntryNames.add(entry.name);
    const targetPath = path.join(input.codexHome, entry.name);
    const sourcePath = path.join(input.sharedCodexHome, entry.name);
    const sourceStats = await lstat(sourcePath);
    const linkResult = await ensureRuntimeLink({
      isDirectory: sourceStats.isDirectory(),
      logger: input.logger,
      logContext: {
        accountId: input.accountId,
        workspaceKind: input.workspaceKind,
        entryName: entry.name,
      },
      logPrefix: "workspace_reconcile.shared_entry",
      sourcePath,
      targetPath,
    });
    summary[linkResult.action] += 1;
    input.logger.debug("workspace_reconcile.shared_entry_ready", {
      accountId: input.accountId,
      workspaceKind: input.workspaceKind,
      entryName: entry.name,
      sourcePath,
      targetPath,
      action: linkResult.action,
      linkType: linkResult.linkType,
    });
  }

  if (input.runtimeContract) {
    for (const rule of input.runtimeContract.fileRules) {
      if (rule.classification !== "shared" || !rule.pathPattern.endsWith("/**")) {
        continue;
      }

      const entryName = rule.pathPattern.slice(0, -3);
      if (entryName.includes("/")) {
        continue;
      }
      if (desiredEntryNames.has(entryName)) {
        continue;
      }

      const sourcePath = path.join(input.sharedCodexHome, entryName);
      await mkdir(sourcePath, { recursive: true });
      desiredEntryNames.add(entryName);
      const linkResult = await ensureRuntimeLink({
        isDirectory: true,
        logger: input.logger,
        logContext: {
          accountId: input.accountId,
          workspaceKind: input.workspaceKind,
          entryName,
          rule: rule.pathPattern,
        },
        logPrefix: "workspace_reconcile.shared_directory_rule",
        sourcePath,
        targetPath: path.join(input.codexHome, entryName),
      });
      summary[linkResult.action] += 1;
      input.logger.debug("workspace_reconcile.shared_directory_rule_ready", {
        accountId: input.accountId,
        workspaceKind: input.workspaceKind,
        entryName,
        rule: rule.pathPattern,
        sourcePath,
        targetPath: path.join(input.codexHome, entryName),
        action: linkResult.action,
        linkType: linkResult.linkType,
      });
    }
  }

  if (input.authSourcePath) {
    desiredEntryNames.add("auth.json");
    const authLink = await ensureRuntimeLink({
      isDirectory: false,
      logger: input.logger,
      logContext: {
        accountId: input.accountId,
        workspaceKind: input.workspaceKind,
        entryName: "auth.json",
      },
      logPrefix: "workspace_reconcile.auth_entry",
      sourcePath: input.authSourcePath,
      targetPath: path.join(input.codexHome, "auth.json"),
    });
    summary[authLink.action] += 1;
    input.logger.info("workspace_reconcile.auth_entry_ready", {
      accountId: input.accountId,
      workspaceKind: input.workspaceKind,
      authSourcePath: input.authSourcePath,
      targetPath: path.join(input.codexHome, "auth.json"),
      action: authLink.action,
      linkType: authLink.linkType,
    });
  }

  const existingEntries = await readdir(input.codexHome, { withFileTypes: true });
  for (const entry of existingEntries) {
    if (desiredEntryNames.has(entry.name)) {
      continue;
    }

    const removed = await removePathIfExists({
      logger: input.logger,
      logContext: {
        accountId: input.accountId,
        workspaceKind: input.workspaceKind,
        entryName: entry.name,
      },
      logPrefix: "workspace_reconcile.stale_entry",
      reason: "missing-from-shared-source",
      targetPath: path.join(input.codexHome, entry.name),
    });
    if (removed) {
      summary.removed += 1;
    }
  }

  input.logger.info("workspace_reconcile.complete", {
    accountId: input.accountId,
    workspaceKind: input.workspaceKind,
    workspaceRoot: input.workspaceRoot,
    codexHome: input.codexHome,
    sharedCodexHome: input.sharedCodexHome,
    authSourcePath: input.authSourcePath,
    summary,
  });
}

function isAccountScopedEntry(
  entryName: string,
  runtimeContract: RuntimeContract | null,
): boolean {
  if (!runtimeContract) {
    return entryName === "auth.json";
  }

  return runtimeContract.fileRules.some((rule) => {
    if (rule.classification !== "account") {
      return false;
    }

    return rule.pathPattern === entryName || rule.pathPattern.startsWith(`${entryName}/`);
  });
}

function createExecutionSessionId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
}
