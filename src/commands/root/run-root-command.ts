import { createLogger } from "../../logging/logger.js";
import type { AppContext } from "../../core/context.js";
import { createAccountRegistry } from "../../accounts/account-registry.js";
import {
  createRuntimeContract,
  summarizeRuntimeContract,
} from "../../runtime/runtime-contract.js";
import { runAccountAddCommand } from "../account-add/run-account-add-command.js";
import { runAccountListCommand } from "../account-list/run-account-list-command.js";
import { runAccountRemoveCommand } from "../account-remove/run-account-remove-command.js";
import { runAccountUseCommand } from "../account-use/run-account-use-command.js";
import { acquireRuntimeLock } from "../../runtime/lock/runtime-lock.js";
import {
  activateAccountIntoSharedRuntime,
  restoreSharedRuntimeFromBackup,
  syncSharedRuntimeBackToAccount,
} from "../../runtime/activate-account/activate-account.js";
import { spawnCodexCommand } from "../../process/spawn-codex-command.js";
import { selectAccountForExecution } from "../../selection/select-account.js";

export async function runRootCommand(context: AppContext): Promise<number> {
  const logger = createLogger({
    level: context.logging.level,
    name: "root",
    sink: context.logging.sink,
  });

  logger.debug("argv.received", { argv: context.argv });
  logger.debug("runtime.detected", {
    sharedCodexHome: context.paths.sharedCodexHome,
    accountRoot: context.paths.accountRoot,
    runtimeRoot: context.paths.runtimeRoot,
    registryFile: context.paths.registryFile,
    wrapperConfigFile: context.paths.wrapperConfigFile,
    selectionCacheFile: context.paths.selectionCacheFile,
    firstRun: context.runtimeInitialization.firstRun,
    copiedSharedArtifacts: context.runtimeInitialization.copiedSharedArtifacts,
    createdRuntimeFiles: context.runtimeInitialization.createdFiles,
    credentialStoreMode: context.wrapperConfig.credentialStoreMode,
    accountSelectionStrategy: context.wrapperConfig.accountSelectionStrategy,
    experimentalSelection: context.wrapperConfig.experimentalSelection,
    codexBinaryPath: context.codexBinary.path,
    recursionGuardSource: context.executablePath,
  });

  const runtimeContract = createRuntimeContract({
    accountRoot: context.paths.accountRoot,
    credentialStoreMode: context.wrapperConfig.credentialStoreMode,
    logger,
    runtimeRoot: context.paths.runtimeRoot,
    sharedCodexHome: context.paths.sharedCodexHome,
  });
  const runtimeSummary = summarizeRuntimeContract(runtimeContract);

  logger.debug("runtime.contract_ready", runtimeSummary);

  if (context.wrapperConfig.credentialStoreMode !== "file") {
    logger.warn("credential_store.unsupported", {
      credentialStoreMode: context.wrapperConfig.credentialStoreMode,
      codexConfigFile: context.paths.codexConfigFile,
      reason: context.wrapperConfig.credentialStorePolicyReason,
    });
  }

  if (context.argv[0] === "account" && context.argv[1] === "add") {
    logger.info("command.dispatch", {
      command: "account add",
      argv: context.argv.slice(2),
    });
    return runAccountAddCommand(context, context.argv.slice(2));
  }

  if (context.argv[0] === "account" && context.argv[1] === "list") {
    logger.info("command.dispatch", {
      command: "account list",
      argv: context.argv.slice(2),
    });
    return runAccountListCommand(context);
  }

  if (context.argv[0] === "account" && context.argv[1] === "remove") {
    logger.info("command.dispatch", {
      command: "account remove",
      argv: context.argv.slice(2),
    });
    return runAccountRemoveCommand(context, context.argv.slice(2));
  }

  if (context.argv[0] === "account" && context.argv[1] === "use") {
    logger.info("command.dispatch", {
      command: "account use",
      argv: context.argv.slice(2),
    });
    return runAccountUseCommand(context, context.argv.slice(2));
  }

  if (context.argv.includes("--help")) {
    context.io.stdout.write(`${buildHelpText()}\n`);
    logger.info("help.rendered");

    return 0;
  }

  if (!context.codexBinary.path) {
    logger.error("command.binary_missing", {
      candidates: context.codexBinary.candidates,
      rejectedCandidates: context.codexBinary.rejectedCandidates,
    });
    throw new Error("Could not find the real `codex` binary on PATH.");
  }

  const registry = createAccountRegistry({
    accountRoot: context.paths.accountRoot,
    logger,
    registryFile: context.paths.registryFile,
  });
  if (context.wrapperConfig.accountSelectionStrategy === "remaining-limit-experimental") {
    logger.warn("selection.experimental_enabled", {
      endpoint: "https://chatgpt.com/backend-api/wham/usage",
      fallbackStrategy: "manual-default",
      timeoutMs: context.wrapperConfig.experimentalSelection.probeTimeoutMs,
      cacheTtlMs: context.wrapperConfig.experimentalSelection.cacheTtlMs,
      useAccountIdHeader: context.wrapperConfig.experimentalSelection.useAccountIdHeader,
    });
  }
  const activeAccount = await selectAccountForExecution({
    experimentalSelection: context.wrapperConfig.experimentalSelection,
    fetchImpl: fetch,
    logger,
    registry,
    selectionCacheFilePath: context.paths.selectionCacheFile,
    strategy: context.wrapperConfig.accountSelectionStrategy,
  });
  const lock = await acquireRuntimeLock({
    logger,
    runtimeRoot: context.paths.runtimeRoot,
  });

  try {
    const activation = await activateAccountIntoSharedRuntime({
      account: activeAccount,
      logger,
      runtimeContract,
      sharedCodexHome: context.paths.sharedCodexHome,
    });

    try {
      const exitCode = await spawnCodexCommand({
        argv: context.argv,
        codexBinaryPath: context.codexBinary.path,
        codexHome: context.paths.sharedCodexHome,
        logger,
      });

      await syncSharedRuntimeBackToAccount({
        logger,
        session: activation,
      });

      return exitCode;
    } catch (error) {
      await restoreSharedRuntimeFromBackup({
        account: activeAccount,
        backupRoot: activation.backupRoot,
        logger,
        runtimeContract,
        sharedCodexHome: context.paths.sharedCodexHome,
      });
      throw error;
    }
  } finally {
    await lock.release();
  }
}

function buildHelpText(): string {
  return [
    "codexes",
    "",
    "Transparent multi-account wrapper around the Codex CLI.",
    "",
    "Usage:",
    "  codexes [args...]",
    "  codexes account add <label> [--timeout-ms <milliseconds>]",
    "  codexes account list",
    "  codexes account use <account-id-or-label>",
    "  codexes account remove <account-id-or-label>",
    "",
    "Runtime model:",
    "  Shared CODEX_HOME is preserved in a wrapper-owned runtime root.",
    "  Account auth state is stored per account and synced back selectively.",
    "",
    "Current status:",
    "  Account management and default Codex passthrough are implemented.",
    "  Selection strategies: manual-default, single-account, remaining-limit-experimental.",
    "  Experimental mode probes https://chatgpt.com/backend-api/wham/usage and falls back to manual-default when ranking is unreliable.",
  ].join("\n");
}
