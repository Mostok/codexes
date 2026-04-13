import { rm } from "node:fs/promises";
import { createLogger } from "../../logging/logger.js";
import type { AppContext } from "../../core/context.js";
import { createAccountRegistry } from "../../accounts/account-registry.js";
import { resolveAccountBySelector } from "../../accounts/account-resolution.js";

export async function runAccountRemoveCommand(
  context: AppContext,
  argv: string[],
): Promise<number> {
  const logger = createLogger({
    level: context.logging.level,
    name: "account_remove",
    sink: context.logging.sink,
  });

  if (argv.includes("--help")) {
    context.io.stdout.write(`${buildAccountRemoveHelpText()}\n`);
    logger.info("help.rendered");
    return 0;
  }

  const selector = argv[0]?.trim();
  if (!selector || argv.length > 1) {
    throw new Error(buildAccountRemoveHelpText());
  }

  const registry = createAccountRegistry({
    accountRoot: context.paths.accountRoot,
    logger,
    registryFile: context.paths.registryFile,
  });
  const accounts = await registry.listAccounts();

  if (accounts.length === 0) {
    context.io.stdout.write("No accounts configured.\n");
    logger.info("command.empty");
    return 0;
  }

  const account = resolveAccountBySelector({ accounts, logger, selector });

  logger.info("command.start", {
    requestedSelector: selector,
    resolvedAccountId: account.id,
    label: account.label,
  });

  await registry.removeAccount(account.id);
  await rm(account.authDirectory, { force: true, recursive: true });

  context.io.stdout.write(`Removed account "${account.label}" (${account.id}).\n`);
  logger.info("command.complete", {
    requestedSelector: selector,
    resolvedAccountId: account.id,
  });

  return 0;
}

function buildAccountRemoveHelpText(): string {
  return [
    "Usage:",
    "  codexes account remove <account-id-or-label>",
  ].join("\n");
}
