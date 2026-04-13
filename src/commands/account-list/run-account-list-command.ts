import { createLogger } from "../../logging/logger.js";
import type { AppContext } from "../../core/context.js";
import { createAccountRegistry } from "../../accounts/account-registry.js";
import { buildAccountPresentations } from "../../accounts/account-resolution.js";

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
  const [accounts, defaultAccount] = await Promise.all([
    registry.listAccounts(),
    registry.getDefaultAccount(),
  ]);

  logger.info("command.start", {
    accountCount: accounts.length,
    defaultAccountId: defaultAccount?.id ?? null,
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

  const presentations = await buildAccountPresentations({ accounts, logger });
  const lines = presentations.map(({ account, authAccountId, authMode }) => {
    const markers = [
      defaultAccount?.id === account.id ? "default" : null,
      authMode ? `auth=${authMode}` : null,
      authAccountId ? `authAccountId=${authAccountId}` : null,
    ]
      .filter((value): value is string => Boolean(value))
      .join(", ");

    return `${defaultAccount?.id === account.id ? "*" : " "} ${account.label} (${account.id})${markers ? ` [${markers}]` : ""}`;
  });

  context.io.stdout.write(`${lines.join("\n")}\n`);
  logger.info("command.complete", {
    accountIds: presentations.map(({ account }) => account.id),
  });

  return 0;
}
