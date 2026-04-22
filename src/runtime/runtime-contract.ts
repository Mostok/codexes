import path from "node:path";
import type { CredentialStoreMode } from "../config/wrapper-config.js";
import type { Logger } from "../logging/logger.js";

export type RuntimeFileClass =
  | "shared"
  | "account"
  | "ephemeral"
  | "protected";

export interface RuntimeFileRule {
  pathPattern: string;
  classification: RuntimeFileClass;
  syncBack: "never" | "if-changed" | "account-to-runtime-only";
  reason: string;
}

export interface RuntimeContract {
  credentialStoreMode: CredentialStoreMode;
  sharedCodexHome: string;
  runtimeRoot: string;
  executionRoot: string;
  perAccountRoot: string;
  supported: boolean;
  fileRules: RuntimeFileRule[];
  syncBackStrategy: {
    whenChildProcessSucceeds: string;
    whenChildProcessFails: string;
    compareStrategy: string;
  };
}

export function createRuntimeContract(input: {
  accountRoot: string;
  credentialStoreMode: CredentialStoreMode;
  executionRoot?: string;
  logger: Logger;
  runtimeRoot: string;
  sharedCodexHome: string;
}): RuntimeContract {
  const contract: RuntimeContract = {
    credentialStoreMode: input.credentialStoreMode,
    sharedCodexHome: input.sharedCodexHome,
    runtimeRoot: input.runtimeRoot,
    executionRoot: input.executionRoot ?? path.join(input.runtimeRoot, "executions"),
    perAccountRoot: input.accountRoot,
    supported: input.credentialStoreMode === "file",
    fileRules: [
      createRule("config.toml", "shared", "never", "Shared CLI behavior and MCP config should remain common."),
      createRule(
        "mcp.json",
        "shared",
        "if-changed",
        "MCP topology is shared across accounts and should persist across isolated runs.",
      ),
      createRule(
        "trust/**",
        "shared",
        "if-changed",
        "Trust metadata is shared across accounts and should persist across isolated runs.",
      ),
      createRule(
        "auth.json",
        "account",
        "if-changed",
        "Windows probe evidence shows auth.json is sufficient for `codex login status`, so it belongs to the active account profile.",
      ),
      createRule(
        "sessions/**",
        "account",
        "if-changed",
        "Safe MVP keeps session state isolated per account until a dedicated probe proves cross-account sharing is safe.",
      ),
      createRule("cache/**", "ephemeral", "never", "Transient caches should be recreated instead of copied."),
      createRule("logs/**", "ephemeral", "never", "Runtime logs are diagnostic and should not sync back."),
      createRule("history.jsonl", "ephemeral", "never", "Conversation history should stay local to each runtime session."),
      createRule("models_cache.json", "ephemeral", "never", "Model cache data can be rebuilt and should not drive account switching."),
      createRule("tmp/**", "ephemeral", "never", "Temporary files should be discarded after each run."),
      createRule(
        "state_*.sqlite*",
        "protected",
        "never",
        "Observed SQLite runtime state exists in the live Codex home and remains unproven for cross-account merge or sync-back.",
      ),
      createRule(
        "logs_*.sqlite*",
        "protected",
        "never",
        "SQLite-backed log databases should stay isolated until a dedicated write-heavy probe proves they are safe to discard or share.",
      ),
      createRule("keyring/**", "protected", "never", "External credential stores are explicitly unsupported for MVP."),
    ],
    syncBackStrategy: {
      whenChildProcessSucceeds:
        "Compare allowed account-classified files and sync only changed files back to the owning account profile.",
      whenChildProcessFails:
        "Restore pre-launch runtime state and avoid syncing ambiguous mutations unless the failure is known-safe.",
      compareStrategy:
        "Use file existence, modified time, and content hash checks before any sync-back write.",
    },
  };

  input.logger.info("runtime.contract_created", {
    sharedCodexHome: contract.sharedCodexHome,
    runtimeRoot: contract.runtimeRoot,
    executionRoot: contract.executionRoot,
    perAccountRoot: contract.perAccountRoot,
    credentialStoreMode: contract.credentialStoreMode,
    supported: contract.supported,
  });

  input.logger.debug("runtime.file_rules", {
    fileRules: contract.fileRules,
    syncBackStrategy: contract.syncBackStrategy,
  });

  return contract;
}

export function resolveAccountRuntimePaths(contract: RuntimeContract, accountId: string) {
  assertSafeAccountId(accountId);
  const accountDirectory = path.join(contract.perAccountRoot, accountId);
  const runtimeBackupDirectory = path.join(contract.runtimeRoot, "backups", accountId);
  const runtimeExecutionDirectory = path.join(contract.executionRoot, accountId);
  const runtimeTempDirectory = path.join(contract.runtimeRoot, "tmp", accountId);

  assertPathInsideRoot(accountDirectory, contract.perAccountRoot, "accountDirectory");
  assertPathInsideRoot(runtimeBackupDirectory, contract.runtimeRoot, "runtimeBackupDirectory");
  assertPathInsideRoot(runtimeExecutionDirectory, contract.executionRoot, "runtimeExecutionDirectory");
  assertPathInsideRoot(runtimeTempDirectory, contract.runtimeRoot, "runtimeTempDirectory");

  return {
    accountDirectory,
    accountStateDirectory: path.join(accountDirectory, "state"),
    accountMetadataFile: path.join(accountDirectory, "account.json"),
    runtimeBackupDirectory,
    runtimeExecutionDirectory,
    runtimeTempDirectory,
  };
}

export function assertSafeAccountId(accountId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(accountId) || accountId === "." || accountId === "..") {
    throw new Error(`Invalid account id "${accountId}".`);
  }
}

export function assertPathInsideRoot(targetPath: string, rootPath: string, label: string): void {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(rootPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }

  throw new Error(`${label} resolved outside its root: ${targetPath}`);
}

export function summarizeRuntimeContract(contract: RuntimeContract) {
  return {
    supported: contract.supported,
    credentialStoreMode: contract.credentialStoreMode,
    sharedCodexHome: contract.sharedCodexHome,
    runtimeRoot: contract.runtimeRoot,
    executionRoot: contract.executionRoot,
    perAccountRoot: contract.perAccountRoot,
    classifications: contract.fileRules.reduce<Record<RuntimeFileClass, number>>(
      (accumulator, rule) => {
        accumulator[rule.classification] += 1;
        return accumulator;
      },
      {
        shared: 0,
        account: 0,
        ephemeral: 0,
        protected: 0,
      },
    ),
  };
}

function createRule(
  pathPattern: string,
  classification: RuntimeFileClass,
  syncBack: RuntimeFileRule["syncBack"],
  reason: string,
): RuntimeFileRule {
  return {
    pathPattern,
    classification,
    syncBack,
    reason,
  };
}
