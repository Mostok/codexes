import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AccountRecord } from "./account-registry.js";
import type { Logger } from "../logging/logger.js";

export interface AccountPresentation {
  account: AccountRecord;
  authAccountId: string | null;
  authMode: string | null;
}

export function resolveAccountBySelector(input: {
  accounts: AccountRecord[];
  logger: Logger;
  selector: string;
}): AccountRecord {
  const normalizedSelector = input.selector.trim();
  const matches = input.accounts.filter(
    (account) =>
      account.id === normalizedSelector ||
      account.label.toLowerCase() === normalizedSelector.toLowerCase(),
  );

  input.logger.debug("account_resolution.lookup", {
    selector: normalizedSelector,
    accountCount: input.accounts.length,
    matchCount: matches.length,
    matchedAccountIds: matches.map((account) => account.id),
  });

  if (matches.length === 0) {
    throw new Error(`No account matches "${normalizedSelector}".`);
  }

  if (matches.length > 1) {
    throw new Error(
      `Selector "${normalizedSelector}" matched multiple accounts; use the account id instead.`,
    );
  }

  const [match] = matches;
  if (!match) {
    throw new Error(`No account matches "${normalizedSelector}".`);
  }

  return match;
}

export async function buildAccountPresentations(input: {
  accounts: AccountRecord[];
  logger: Logger;
}): Promise<AccountPresentation[]> {
  const presentations: AccountPresentation[] = [];

  for (const account of input.accounts) {
    presentations.push({
      account,
      ...(await readAccountMetadataSummary(account, input.logger)),
    });
  }

  return presentations;
}

async function readAccountMetadataSummary(
  account: AccountRecord,
  logger: Logger,
): Promise<Pick<AccountPresentation, "authAccountId" | "authMode">> {
  const metadataFile = path.join(account.authDirectory, "account.json");

  try {
    const raw = await readFile(metadataFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const summary = {
      authAccountId:
        typeof parsed.authAccountId === "string" ? parsed.authAccountId : null,
      authMode: typeof parsed.authMode === "string" ? parsed.authMode : null,
    };

    logger.debug("account_resolution.metadata_loaded", {
      accountId: account.id,
      metadataFile,
      authAccountId: summary.authAccountId,
      authMode: summary.authMode,
    });

    return summary;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      logger.debug("account_resolution.metadata_missing", {
        accountId: account.id,
        metadataFile,
      });
      return { authAccountId: null, authMode: null };
    }

    logger.warn("account_resolution.metadata_failed", {
      accountId: account.id,
      metadataFile,
      message: error instanceof Error ? error.message : String(error),
    });

    return { authAccountId: null, authMode: null };
  }
}
