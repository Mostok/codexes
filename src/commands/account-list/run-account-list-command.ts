import { createLogger } from "../../logging/logger.js";
import type { AppContext } from "../../core/context.js";
import { createAccountRegistry } from "../../accounts/account-registry.js";
import { formatSelectionSummary } from "../../selection/format-selection-summary.js";
import { resolveSelectionSummary } from "../../selection/selection-summary.js";

export async function runAccountListCommand(context: AppContext): Promise<number> {
  const logger = createLogger({
    level: context.logging.level,
    name: "account_list",
    sink: context.logging.sink,
  });
  const registry = createAccountRegistry({
    accountRoot: context.paths.accountRoot,
    logger,
    registryFile: context.paths.registryFile,
  });
  const accounts = await registry.listAccounts();

  logger.info("command.start", {
    accountCount: accounts.length,
  });

  if (accounts.length === 0) {
    context.io.stdout.write(
      [
        "No accounts configured.",
        "Add one with: codexes account add <label>",
      ].join("\n") + "\n",
    );
    logger.info("command.empty");
    return 0;
  }

  const summary = await resolveSelectionSummary({
    experimentalSelection: context.wrapperConfig.experimentalSelection,
    fetchImpl: fetch,
    logger,
    mode: "display-only",
    registry,
    selectionCacheFilePath: context.paths.selectionCacheFile,
    strategy: context.wrapperConfig.accountSelectionStrategy,
  });
  const formattedSummary = formatSelectionSummary({
    capabilities: {
      stdoutIsTTY: context.output.stdoutIsTTY,
      useColor: context.output.stdoutIsTTY,
    },
    logger,
    renderVariant: "display-table",
    summary,
  });
  context.io.stdout.write(formattedSummary);
  logger.info("summary_rendered", {
    mode: summary.mode,
    renderVariant: "display-table",
    strategy: summary.strategy,
    useColor: context.output.stdoutIsTTY,
    selectedAccountId: summary.selectedAccount?.id ?? null,
    fallbackReason: summary.fallbackReason,
    executionBlockedReason: summary.executionBlockedReason,
  });
  if (summary.fallbackReason || summary.executionBlockedReason) {
    logger.warn("fallback_announced", {
      fallbackReason: summary.fallbackReason,
      selectedAccountId: summary.selectedAccount?.id ?? null,
      executionBlockedReason: summary.executionBlockedReason,
    });
  }
  logger.info("command.complete", {
    accountIds: summary.entries.map(({ account }) => account.id),
  });

  return 0;
}
