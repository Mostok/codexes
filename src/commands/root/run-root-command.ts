import path from "node:path";
import { createLogger } from "../../logging/logger.js";
import type { AppContext } from "../../core/context.js";
import { createAccountRegistry } from "../../accounts/account-registry.js";
import {
  createRuntimeContract,
  summarizeRuntimeContract,
} from "../../runtime/runtime-contract.js";
import { runAccountAddCommand } from "../account-add/run-account-add-command.js";
import { runAccountListCommand } from "../account-list/run-account-list-command.js";
import { runAccountRenameCommand } from "../account-rename/run-account-rename-command.js";
import { runAccountSetPaidAtCommand } from "../account-set-paid-at/run-account-set-paid-at-command.js";
import { runAccountRemoveCommand } from "../account-remove/run-account-remove-command.js";
import { runAccountUseCommand } from "../account-use/run-account-use-command.js";
import {
  activateAccountIntoSharedRuntime,
  restoreSharedRuntimeFromBackup,
  syncSharedRuntimeBackToAccount,
} from "../../runtime/activate-account/activate-account.js";
import {
  cleanupExecutionWorkspace,
  prepareExecutionWorkspace,
  sanitizeRetainedExecutionWorkspace,
} from "../../runtime/login-workspace.js";
import { spawnCodexCommand } from "../../process/spawn-codex-command.js";
import { formatSelectionSummary } from "../../selection/format-selection-summary.js";
import { resolveSelectionSummary } from "../../selection/selection-summary.js";

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
    executionRoot: context.paths.executionRoot,
    registryFile: context.paths.registryFile,
    wrapperConfigFile: context.paths.wrapperConfigFile,
    selectionCacheFile: context.paths.selectionCacheFile,
    firstRun: context.runtimeInitialization.firstRun,
    copiedSharedArtifacts: context.runtimeInitialization.copiedSharedArtifacts,
    createdRuntimeFiles: context.runtimeInitialization.createdFiles,
    credentialStoreMode: context.wrapperConfig.credentialStoreMode,
    accountSelectionStrategy: context.wrapperConfig.accountSelectionStrategy,
    accountSelectionStrategySource: context.wrapperConfig.accountSelectionStrategySource,
    runtimeModel: context.wrapperConfig.runtimeModel,
    runtimeModelSource: context.wrapperConfig.runtimeModelSource,
    experimentalSelection: context.wrapperConfig.experimentalSelection,
    codexBinaryPath: context.codexBinary.path,
    recursionGuardSource: context.executablePath,
  });

  const runtimeContract = createRuntimeContract({
    accountRoot: context.paths.accountRoot,
    credentialStoreMode: context.wrapperConfig.credentialStoreMode,
    logger,
    runtimeRoot: context.paths.runtimeRoot,
    executionRoot: context.paths.executionRoot,
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

  if (context.argv[0] === "account" && context.argv[1] === "rename") {
    logger.info("command.dispatch", {
      command: "account rename",
      argv: context.argv.slice(2),
    });
    return runAccountRenameCommand(context, context.argv.slice(2));
  }

  if (context.argv[0] === "account" && context.argv[1] === "set-paid-at") {
    logger.info("command.dispatch", {
      command: "account set-paid-at",
      argv: context.argv.slice(2),
    });
    return runAccountSetPaidAtCommand(context, context.argv.slice(2));
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
  logger.info("selection.strategy_active", {
    strategy: context.wrapperConfig.accountSelectionStrategy,
    source: context.wrapperConfig.accountSelectionStrategySource,
  });

  if (
    context.wrapperConfig.accountSelectionStrategy === "remaining-limit" ||
    context.wrapperConfig.accountSelectionStrategy === "remaining-limit-experimental"
  ) {
    logger.info("selection.experimental_enabled", {
      endpoint: "https://chatgpt.com/backend-api/wham/usage",
      fallbackStrategy: "manual-default",
      timeoutMs: context.wrapperConfig.experimentalSelection.probeTimeoutMs,
      cacheTtlMs: context.wrapperConfig.experimentalSelection.cacheTtlMs,
      useAccountIdHeader: context.wrapperConfig.experimentalSelection.useAccountIdHeader,
      source: context.wrapperConfig.accountSelectionStrategySource,
    });
  }
  const selectionSummary = await resolveSelectionSummary({
    experimentalSelection: context.wrapperConfig.experimentalSelection,
    fetchImpl: fetch,
    logger,
    mode: "execution",
    registry,
    selectionCacheFilePath: context.paths.selectionCacheFile,
    strategy: context.wrapperConfig.accountSelectionStrategy,
  });
  const activeAccount = selectionSummary.selectedAccount;
  if (!activeAccount || !selectionSummary.selectedBy) {
    logger.error("selection.execution_summary_incomplete", {
      strategy: selectionSummary.strategy,
      fallbackReason: selectionSummary.fallbackReason,
      executionBlockedReason: selectionSummary.executionBlockedReason,
    });
    throw new Error(
      selectionSummary.executionBlockedReason ?? "Execution selection did not resolve an account.",
    );
  }
  const formattedSummary = formatSelectionSummary({
    capabilities: {
      stdoutIsTTY: context.output.stdoutIsTTY,
      useColor: context.output.stdoutIsTTY,
    },
    logger,
    renderVariant: "display-table",
    summary: selectionSummary,
  });
  context.io.stdout.write(formattedSummary);
  logger.info("summary_rendered", {
    mode: selectionSummary.mode,
    renderVariant: "display-table",
    strategy: selectionSummary.strategy,
    useColor: context.output.stdoutIsTTY,
    selectedAccountId: activeAccount.id,
    fallbackReason: selectionSummary.fallbackReason,
    executionBlockedReason: selectionSummary.executionBlockedReason,
  });
  logger.info("selected_account_announced", {
    accountId: activeAccount.id,
    label: activeAccount.label,
    selectedBy: selectionSummary.selectedBy,
  });
  if (selectionSummary.fallbackReason) {
    logger.warn("fallback_announced", {
      fallbackReason: selectionSummary.fallbackReason,
      selectedAccountId: activeAccount.id,
    });
  }
  if (context.wrapperConfig.runtimeModel === "legacy-shared") {
    logger.warn("runtime_model.legacy_fallback", {
      accountId: activeAccount.id,
      sharedCodexHome: context.paths.sharedCodexHome,
      reason: "CODEXES_RUNTIME_MODEL selected legacy shared runtime",
    });
    return runLegacySharedRuntimeFlow({
      activeAccount,
      argv: context.argv,
      codexBinaryPath: context.codexBinary.path,
      logger,
      runtimeContract,
      runtimeRoot: context.paths.runtimeRoot,
      sharedCodexHome: context.paths.sharedCodexHome,
    });
  }

  logger.info("runtime_model.isolated_execution.start", {
    accountId: activeAccount.id,
    label: activeAccount.label,
    runtimeRoot: context.paths.runtimeRoot,
    executionRoot: context.paths.executionRoot,
  });

  logger.info("runtime_model.isolated_execution.prepare.start", {
    accountId: activeAccount.id,
    label: activeAccount.label,
    phase: "prepare",
  });

  let workspace: Awaited<ReturnType<typeof prepareExecutionWorkspace>>;
  try {
    workspace = await prepareExecutionWorkspace({
      account: activeAccount,
      logger,
      runtimeContract,
      sharedCodexHome: context.paths.sharedCodexHome,
    });
  } catch (error) {
    logger.error("runtime_model.isolated_execution.prepare_workspace_failed", {
      accountId: activeAccount.id,
      label: activeAccount.label,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  logger.info("runtime_model.isolated_execution.prepare.complete", {
    accountId: activeAccount.id,
    label: activeAccount.label,
    sessionId: workspace.sessionId,
    phase: "prepare",
  });

  try {
    logger.info("runtime_model.isolated_execution.child_run.start", {
      accountId: activeAccount.id,
      label: activeAccount.label,
      sessionId: workspace.sessionId,
      codexHome: workspace.codexHome,
      phase: "child_run",
    });
    const exitCode = await spawnCodexCommand({
      argv: context.argv,
      codexBinaryPath: context.codexBinary.path,
      codexHome: workspace.codexHome,
      logger,
    });
    logger.info("runtime_model.isolated_execution.child_run.complete", {
      accountId: activeAccount.id,
      label: activeAccount.label,
      sessionId: workspace.sessionId,
      exitCode,
      phase: "child_run",
    });

    logger.info("runtime_model.isolated_execution.direct_links_active", {
      accountId: activeAccount.id,
      label: activeAccount.label,
      sessionId: workspace.sessionId,
      codexHome: workspace.codexHome,
      authSource: path.join(workspace.accountStateRoot, "auth.json"),
      sharedCodexHome: context.paths.sharedCodexHome,
      syncBackRequired: false,
    });

    logger.info("runtime_model.isolated_execution.complete", {
      accountId: activeAccount.id,
      sessionId: workspace.sessionId,
      exitCode,
    });

    return exitCode;
  } finally {
    logger.info("runtime_model.isolated_execution.cleanup.start", {
      accountId: activeAccount.id,
      label: activeAccount.label,
      sessionId: workspace.sessionId,
      workspaceRoot: workspace.workspaceRoot,
      phase: "cleanup",
    });
    await cleanupExecutionWorkspace({
      logger,
      workspace,
    });
    await sanitizeRetainedExecutionWorkspace({
      logger,
      runtimeContract,
      workspace,
    });
    logger.info("runtime_model.isolated_execution.cleanup.complete", {
      accountId: activeAccount.id,
      label: activeAccount.label,
      sessionId: workspace.sessionId,
      workspaceRoot: workspace.workspaceRoot,
      cleanedUp: false,
      phase: "cleanup",
    });
  }
}

async function runLegacySharedRuntimeFlow(input: {
  activeAccount: NonNullable<Awaited<ReturnType<typeof resolveSelectionSummary>>["selectedAccount"]>;
  argv: string[];
  codexBinaryPath: string;
  logger: ReturnType<typeof createLogger>;
  runtimeContract: ReturnType<typeof createRuntimeContract>;
  runtimeRoot: string;
  sharedCodexHome: string;
}): Promise<number> {
  const activation = await activateAccountIntoSharedRuntime({
    account: input.activeAccount,
    logger: input.logger,
    runtimeContract: input.runtimeContract,
    sharedCodexHome: input.sharedCodexHome,
  });

  try {
    const exitCode = await spawnCodexCommand({
      argv: input.argv,
      codexBinaryPath: input.codexBinaryPath,
      codexHome: input.sharedCodexHome,
      logger: input.logger,
    });

    if (exitCode !== 0) {
      input.logger.warn("runtime_model.legacy_shared.sync_back_skipped", {
        accountId: input.activeAccount.id,
        exitCode,
        reason: "child process exited unsuccessfully",
      });
      await restoreSharedRuntimeFromBackup({
        account: input.activeAccount,
        backupRoot: activation.backupRoot,
        logger: input.logger,
        runtimeContract: input.runtimeContract,
        sharedCodexHome: input.sharedCodexHome,
      });
      return exitCode;
    }

    await syncSharedRuntimeBackToAccount({
      logger: input.logger,
      session: activation,
    });

    return exitCode;
  } catch (error) {
    await restoreSharedRuntimeFromBackup({
      account: input.activeAccount,
      backupRoot: activation.backupRoot,
      logger: input.logger,
      runtimeContract: input.runtimeContract,
      sharedCodexHome: input.sharedCodexHome,
    });
    throw error;
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
    "  codexes account add <label> [--paid-at <dd.mm.yyyy>] [--timeout-ms <milliseconds>]",
    "  codexes account list",
    "  codexes account rename <account-id-or-label> <new-label>",
    "  codexes account set-paid-at <account-id-or-label> <dd.mm.yyyy>",
    "  codexes account use <account-id-or-label>",
    "  codexes account remove <account-id-or-label>",
    "",
    "Runtime model:",
    "  Shared CODEX_HOME stays the live Codex home.",
    "  Each account reuses its own linked codex-home with only auth.json routed per account.",
    "",
    "Current status:",
    "  Account management and default Codex passthrough are implemented.",
    "  Default selection strategy: remaining-limit.",
    "  Available overrides: manual-default, single-account, remaining-limit.",
    "  Legacy compatibility override: remaining-limit-experimental.",
    "  Remaining-limit mode probes https://chatgpt.com/backend-api/wham/usage and falls back to manual-default when ranking is unreliable.",
  ].join("\n");
}
