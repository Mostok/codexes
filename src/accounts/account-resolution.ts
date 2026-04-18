import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AccountRecord } from "./account-registry.js";
import type { Logger } from "../logging/logger.js";
import { formatAccountPaidDateDisplay } from "./account-paid-date.js";

export interface AccountPresentation {
  account: AccountRecord;
  authAccountId: string | null;
  authMode: string | null;
  paidAt: AccountPaidAt;
}

export interface AccountPaidAt {
  displayValue: string | null;
  isoValue: string | null;
  source: string;
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
): Promise<Pick<AccountPresentation, "authAccountId" | "authMode" | "paidAt">> {
  const metadataFile = path.join(account.authDirectory, "account.json");

  logger.debug("account_resolution.metadata_read_start", {
    accountId: account.id,
    metadataFile,
  });

  try {
    const raw = await readFile(metadataFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const paidAt = resolvePaidAt({
      account,
      logger,
      metadataFile,
      parsed,
    });
    const summary = {
      authAccountId:
        typeof parsed.authAccountId === "string" ? parsed.authAccountId : null,
      authMode: typeof parsed.authMode === "string" ? parsed.authMode : null,
      paidAt,
    };

    logger.debug("account_resolution.metadata_loaded", {
      accountId: account.id,
      metadataFile,
      authAccountId: summary.authAccountId,
      authMode: summary.authMode,
      paidAt: summary.paidAt,
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
      return {
        authAccountId: null,
        authMode: null,
        paidAt: { displayValue: null, isoValue: null, source: "metadata-missing" },
      };
    }

    logger.error("account_resolution.metadata_failed", {
      accountId: account.id,
      metadataFile,
      message: error instanceof Error ? error.message : String(error),
    });

    return {
      authAccountId: null,
      authMode: null,
      paidAt: { displayValue: null, isoValue: null, source: "metadata-error" },
    };
  }
}

function resolvePaidAt(input: {
  account: AccountRecord;
  logger: Logger;
  metadataFile: string;
  parsed: Record<string, unknown>;
}): AccountPaidAt {
  const explicitPaidDate = resolvePaidAtCandidate({
    accountId: input.account.id,
    candidates: [
      { source: "metadata.subscriptionPaidAt", value: input.parsed.subscriptionPaidAt },
      { source: "metadata.subscription_paid_at", value: input.parsed.subscription_paid_at },
      { source: "metadata.subscriptionAcquiredAt", value: input.parsed.subscriptionAcquiredAt },
      { source: "metadata.subscription_acquired_at", value: input.parsed.subscription_acquired_at },
      { source: "metadata.subscriptionStartedAt", value: input.parsed.subscriptionStartedAt },
      { source: "metadata.subscriptionStartAt", value: input.parsed.subscriptionStartAt },
    ],
    logger: input.logger,
    metadataFile: input.metadataFile,
  });

  if (explicitPaidDate) {
    return explicitPaidDate;
  }

  input.logger.debug("account_resolution.paid_at_missing", {
    accountId: input.account.id,
    metadataFile: input.metadataFile,
  });

  return { displayValue: null, isoValue: null, source: "no-paid-date" };
}

function resolvePaidAtCandidate(input: {
  accountId: string;
  candidates: Array<{ source: string; value: unknown }>;
  logger: Logger;
  metadataFile: string;
}): AccountPaidAt | null {
  for (const candidate of input.candidates) {
    const isoValue = normalizeIsoLikeTimestamp(candidate.value);
    if (!isoValue) {
      continue;
    }

    const displayValue = formatAccountPaidDateDisplay(isoValue);
    if (!displayValue) {
      continue;
    }

    input.logger.debug("account_resolution.paid_at_candidate_loaded", {
      accountId: input.accountId,
      isoValue,
      displayValue,
      metadataFile: input.metadataFile,
      source: candidate.source,
    });

    return {
      displayValue,
      isoValue,
      source: candidate.source,
    };
  }

  const invalidCandidates = input.candidates
    .filter((candidate) => typeof candidate.value === "string" && candidate.value.trim().length > 0)
    .map((candidate) => ({
      source: candidate.source,
      value: String(candidate.value).trim(),
    }));

  if (invalidCandidates.length > 0) {
    input.logger.warn("account_resolution.paid_at_candidate_invalid", {
      accountId: input.accountId,
      invalidCandidates,
      metadataFile: input.metadataFile,
    });
  }

  return null;
}

function normalizeIsoLikeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    return null;
  }

  return Number.isNaN(Date.parse(normalizedValue)) ? null : normalizedValue;
}
