import { readFile, writeFile } from "node:fs/promises";
import { createLogger } from "../../logging/logger.js";
import type { AppContext } from "../../core/context.js";
import { createAccountRegistry } from "../../accounts/account-registry.js";
import { resolveAccountBySelector } from "../../accounts/account-resolution.js";
import {
  createRuntimeContract,
  resolveAccountRuntimePaths,
} from "../../runtime/runtime-contract.js";

export async function runAccountRenameCommand(
  context: AppContext,
  argv: string[],
): Promise<number> {
  const logger = createLogger({
    level: context.logging.level,
    name: "account_rename",
    sink: context.logging.sink,
  });

  if (argv.includes("--help")) {
    context.io.stdout.write(`${buildAccountRenameHelpText()}\n`);
    logger.info("help.rendered");
    return 0;
  }

  const parsed = parseAccountRenameArgs(argv);
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

  const account = resolveAccountBySelector({
    accounts,
    logger,
    selector: parsed.selector,
  });
  const previousLabel = account.label;

  logger.info("command.start", {
    requestedSelector: parsed.selector,
    resolvedAccountId: account.id,
    previousLabel,
    requestedLabel: parsed.label,
  });

  const renamedAccount = await registry.renameAccount(account.id, parsed.label);

  try {
    const runtimeContract = createRuntimeContract({
      accountRoot: context.paths.accountRoot,
      credentialStoreMode: context.wrapperConfig.credentialStoreMode,
      logger,
      runtimeRoot: context.paths.runtimeRoot,
      sharedCodexHome: context.paths.sharedCodexHome,
    });
    const runtimePaths = resolveAccountRuntimePaths(runtimeContract, renamedAccount.id);

    await updateAccountMetadataLabel({
      accountId: renamedAccount.id,
      label: renamedAccount.label,
      logger,
      metadataFile: runtimePaths.accountMetadataFile,
    });
  } catch (error) {
    logger.error("command.metadata_sync_failed", {
      accountId: renamedAccount.id,
      previousLabel,
      label: renamedAccount.label,
      message: error instanceof Error ? error.message : String(error),
    });

    await registry.renameAccount(renamedAccount.id, previousLabel).catch(
      (rollbackError: unknown) => {
        logger.error("command.rollback_failed", {
          accountId: renamedAccount.id,
          previousLabel,
          label: renamedAccount.label,
          message:
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      },
    );

    throw error;
  }

  context.io.stdout.write(
    `Renamed account "${previousLabel}" (${renamedAccount.id}) to "${renamedAccount.label}".\n`,
  );
  logger.info("command.complete", {
    requestedSelector: parsed.selector,
    resolvedAccountId: renamedAccount.id,
    previousLabel,
    label: renamedAccount.label,
  });

  return 0;
}

function parseAccountRenameArgs(argv: string[]): {
  label: string;
  selector: string;
} {
  const selector = argv[0]?.trim();
  const label = argv[1]?.trim();

  if (!selector || !label || argv.length > 2) {
    throw new Error(buildAccountRenameHelpText());
  }

  return { label, selector };
}

function buildAccountRenameHelpText(): string {
  return [
    "Usage:",
    "  codexes account rename <account-id-or-label> <new-label>",
  ].join("\n");
}

async function updateAccountMetadataLabel(input: {
  accountId: string;
  label: string;
  logger: ReturnType<typeof createLogger>;
  metadataFile: string;
}): Promise<void> {
  const raw = await readFile(input.metadataFile, "utf8");
  const metadata = JSON.parse(raw) as Record<string, unknown>;

  metadata.label = input.label;

  await writeFile(input.metadataFile, JSON.stringify(metadata, null, 2), "utf8");

  input.logger.info("account_metadata.renamed", {
    accountId: input.accountId,
    metadataFile: input.metadataFile,
    label: input.label,
  });
}
