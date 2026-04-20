import { readFile, writeFile } from "node:fs/promises";
import { createLogger } from "../../logging/logger.js";
import type { AppContext } from "../../core/context.js";
import { createAccountRegistry } from "../../accounts/account-registry.js";
import { parseAccountPaidDate } from "../../accounts/account-paid-date.js";
import { resolveAccountBySelector } from "../../accounts/account-resolution.js";
import {
  createRuntimeContract,
  resolveAccountRuntimePaths,
} from "../../runtime/runtime-contract.js";

export async function runAccountSetPaidAtCommand(
  context: AppContext,
  argv: string[],
): Promise<number> {
  const logger = createLogger({
    level: context.logging.level,
    name: "account_set_paid_at",
    sink: context.logging.sink,
  });

  if (argv.includes("--help")) {
    context.io.stdout.write(`${buildAccountSetPaidAtHelpText()}\n`);
    logger.info("help.rendered");
    return 0;
  }

  const parsed = parseAccountSetPaidAtArgs(argv, logger);
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
  const runtimeContract = createRuntimeContract({
    accountRoot: context.paths.accountRoot,
    credentialStoreMode: context.wrapperConfig.credentialStoreMode,
    executionRoot: context.paths.executionRoot,
    logger,
    runtimeRoot: context.paths.runtimeRoot,
    sharedCodexHome: context.paths.sharedCodexHome,
  });
  const runtimePaths = resolveAccountRuntimePaths(runtimeContract, account.id);

  logger.info("command.start", {
    requestedSelector: parsed.selector,
    resolvedAccountId: account.id,
    label: account.label,
    requestedPaidAt: parsed.paidAt.displayValue,
    normalizedPaidAtIso: parsed.paidAt.isoValue,
    metadataFile: runtimePaths.accountMetadataFile,
  });

  const previousPaidAt = await updateAccountPaidAtMetadata({
    accountId: account.id,
    logger,
    metadataFile: runtimePaths.accountMetadataFile,
    paidAtIso: parsed.paidAt.isoValue,
  });

  context.io.stdout.write(
    `Updated payed date for "${account.label}" (${account.id}) to ${parsed.paidAt.displayValue}.\n`,
  );
  logger.info("command.complete", {
    requestedSelector: parsed.selector,
    resolvedAccountId: account.id,
    previousPaidAt,
    paidAtDisplayValue: parsed.paidAt.displayValue,
    paidAtIso: parsed.paidAt.isoValue,
  });

  return 0;
}

function parseAccountSetPaidAtArgs(
  argv: string[],
  logger: ReturnType<typeof createLogger>,
): {
  paidAt: {
    displayValue: string;
    isoValue: string;
  };
  selector: string;
} {
  const selector = argv[0]?.trim();
  const rawPaidAt = argv[1]?.trim();

  if (!selector || !rawPaidAt || argv.length > 2) {
    throw new Error(buildAccountSetPaidAtHelpText());
  }

  return {
    paidAt: parseAccountPaidDate({
      logger,
      rawValue: rawPaidAt,
      source: "account set-paid-at",
    }),
    selector,
  };
}

function buildAccountSetPaidAtHelpText(): string {
  return [
    "Usage:",
    "  codexes account set-paid-at <account-id-or-label> <dd.mm.yyyy>",
  ].join("\n");
}

async function updateAccountPaidAtMetadata(input: {
  accountId: string;
  logger: ReturnType<typeof createLogger>;
  metadataFile: string;
  paidAtIso: string;
}): Promise<string | null> {
  input.logger.debug("account_metadata.paid_at_update_start", {
    accountId: input.accountId,
    metadataFile: input.metadataFile,
    paidAtIso: input.paidAtIso,
  });

  const raw = await readFile(input.metadataFile, "utf8").catch((error: unknown) => {
    input.logger.error("account_metadata.paid_at_read_failed", {
      accountId: input.accountId,
      metadataFile: input.metadataFile,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  });
  const metadata = JSON.parse(raw) as Record<string, unknown>;
  const previousPaidAt =
    typeof metadata.subscriptionPaidAt === "string"
      ? metadata.subscriptionPaidAt
      : typeof metadata.subscriptionAcquiredAt === "string"
        ? metadata.subscriptionAcquiredAt
        : null;

  metadata.subscriptionPaidAt = input.paidAtIso;

  await writeFile(input.metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8").catch(
    (error: unknown) => {
      input.logger.error("account_metadata.paid_at_write_failed", {
        accountId: input.accountId,
        metadataFile: input.metadataFile,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    },
  );

  input.logger.info("account_metadata.paid_at_updated", {
    accountId: input.accountId,
    metadataFile: input.metadataFile,
    previousPaidAt,
    paidAtIso: input.paidAtIso,
  });

  return previousPaidAt;
}
