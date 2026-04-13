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
  logger: Logger;
  runtimeRoot: string;
  sharedCodexHome: string;
}): RuntimeContract {
  const contract: RuntimeContract = {
    credentialStoreMode: input.credentialStoreMode,
    sharedCodexHome: input.sharedCodexHome,
    runtimeRoot: input.runtimeRoot,
    perAccountRoot: input.accountRoot,
    supported: input.credentialStoreMode === "file",
    fileRules: [
      createRule("config.toml", "shared", "never", "Shared CLI behavior and MCP config should remain common."),
      createRule("mcp.json", "shared", "never", "MCP topology is shared across accounts."),
      createRule("trust/**", "shared", "never", "Trust metadata should not be overwritten per account."),
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
        "Session refresh artifacts are still treated as account-scoped until a real token-refresh probe proves otherwise.",
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
  const accountDirectory = path.join(contract.perAccountRoot, accountId);

  return {
    accountDirectory,
    accountStateDirectory: path.join(accountDirectory, "state"),
    accountMetadataFile: path.join(accountDirectory, "account.json"),
    runtimeBackupDirectory: path.join(contract.runtimeRoot, "backups", accountId),
    runtimeTempDirectory: path.join(contract.runtimeRoot, "tmp", accountId),
  };
}

export function summarizeRuntimeContract(contract: RuntimeContract) {
  return {
    supported: contract.supported,
    credentialStoreMode: contract.credentialStoreMode,
    sharedCodexHome: contract.sharedCodexHome,
    runtimeRoot: contract.runtimeRoot,
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
