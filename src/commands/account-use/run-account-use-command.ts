import { createLogger } from "../../logging/logger.js";
import type { AppContext } from "../../core/context.js";
import { createAccountRegistry } from "../../accounts/account-registry.js";
import { resolveAccountBySelector } from "../../accounts/account-resolution.js";

export async function runAccountUseCommand(
  context: AppContext,
  argv: string[],
): Promise<number> {
  const logger = createLogger({
    level: context.logging.level,
    name: "account_use",
    sink: context.logging.sink,
  });

  if (argv.includes("--help")) {
    context.io.stdout.write(`${buildAccountUseHelpText()}\n`);
    logger.info("help.rendered");
    return 0;
  }

  const registry = createAccountRegistry({
    accountRoot: context.paths.accountRoot,
    logger,
    registryFile: context.paths.registryFile,
  });
  const accounts = await registry.listAccounts();

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

  const selector = argv[0]?.trim() ?? null;
  if (argv.length > 1) {
    throw new Error(buildAccountUseHelpText());
  }

  let targetAccount = null;
  if (!selector) {
    if (accounts.length === 1) {
      const [singleAccount] = accounts;
      if (!singleAccount) {
        throw new Error("No accounts configured.");
      }
      targetAccount = singleAccount;
      logger.info("command.single_account_default", {
        resolvedAccountId: targetAccount.id,
        label: targetAccount.label,
      });
    } else {
      throw new Error(
        "Multiple accounts exist. Specify which one to use: codexes account use <account-id-or-label>",
      );
    }
  } else {
    targetAccount = resolveAccountBySelector({ accounts, logger, selector });
  }

  if (!targetAccount) {
    throw new Error("Could not resolve the account to use.");
  }

  logger.info("command.start", {
    requestedSelector: selector,
    resolvedAccountId: targetAccount.id,
    label: targetAccount.label,
  });

  const selectedAccount = await registry.selectAccount(targetAccount.id);

  context.io.stdout.write(
    `Using account "${selectedAccount.label}" (${selectedAccount.id}) as the default.\n`,
  );
  logger.info("command.complete", {
    requestedSelector: selector,
    resolvedAccountId: selectedAccount.id,
  });

  return 0;
}

function buildAccountUseHelpText(): string {
  return [
    "Usage:",
    "  codexes account use <account-id-or-label>",
    "  codexes account use",
    "",
    "When only one account exists, `codexes account use` selects it automatically.",
  ].join("\n");
}
