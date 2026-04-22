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
        "never",
        "MCP topology lives directly in the shared Codex home and reaches account workspaces through links.",
      ),
      createRule(
        "trust/**",
        "shared",
        "never",
        "Trust metadata is shared live through directory links and should never require sync-back.",
      ),
      createRule(
        "auth.json",
        "account",
        "account-to-runtime-only",
        "auth.json is the only account-routed artifact and must always resolve to accounts/<id>/state/auth.json.",
      ),
      createRule(
        "sessions/**",
        "shared",
        "never",
        "Session state is intentionally shared because every account workspace is just a linked projection of one Codex home.",
      ),
      createRule("cache/**", "shared", "never", "Caches are part of the single shared Codex state."),
      createRule("logs/**", "shared", "never", "Logs live in the shared Codex home and are visible through links."),
      createRule("history.jsonl", "shared", "never", "Conversation history is shared intentionally across account workspaces."),
      createRule("models_cache.json", "shared", "never", "Model cache should remain shared with the live Codex home."),
      createRule("tmp/**", "ephemeral", "never", "Temporary files should be discarded after each run."),
      createRule(
        "state_*.sqlite*",
        "shared",
        "never",
        "SQLite runtime state is part of the shared Codex home and is consumed through links.",
      ),
      createRule(
        "logs_*.sqlite*",
        "shared",
        "never",
        "SQLite-backed logs are part of the shared Codex state and should stay live-linked.",
      ),
      createRule("keyring/**", "protected", "never", "External credential stores are explicitly unsupported for MVP."),
    ],
    syncBackStrategy: {
      whenChildProcessSucceeds:
        "No sync-back is required because shared files stay linked to the live Codex home and auth.json links directly to account state.",
      whenChildProcessFails:
        "Keep the linked workspace in place; the next reconcile pass repairs stale links without copying runtime state.",
      compareStrategy:
        "Reconcile desired links on workspace preparation and replace stale or incorrect entries in place.",
    },
  };

  input.logger.info("runtime.contract_created", {
    sharedCodexHome: contract.sharedCodexHome,
    runtimeRoot: contract.runtimeRoot,
    executionRoot: contract.executionRoot,
    perAccountRoot: contract.perAccountRoot,
    credentialStoreMode: contract.credentialStoreMode,
    supported: contract.supported,
    accountScopedArtifacts: contract.fileRules
      .filter((rule) => rule.classification === "account")
      .map((rule) => rule.pathPattern),
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
