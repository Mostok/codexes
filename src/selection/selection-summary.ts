import {
  buildAccountPresentations,
  type AccountPaidAt,
} from "../accounts/account-resolution.js";
import type { AccountRecord, AccountRegistry } from "../accounts/account-registry.js";
import type {
  AccountSelectionStrategy,
  ExperimentalSelectionConfig,
} from "../config/wrapper-config.js";
import type { Logger } from "../logging/logger.js";
import {
  resolveAccountSubscriptionExpiration,
  type AccountSubscriptionExpiration,
} from "./subscription-client.js";
import { resolveAccountUsageSnapshots, type AccountUsageResolution } from "./usage-probe-coordinator.js";
import type { UsageProbeFailureCategory } from "./usage-client.js";
import type { NormalizedUsageSnapshot } from "./usage-types.js";

const DISABLED_SELECTION_BLOCKED_REASON =
  "Selected account is disabled by subscription expiration or plan and cannot be used.";
const DISABLED_AUTO_SELECTION_BLOCKED_REASON =
  "Remaining-limit selection did not resolve an eligible account because the fallback account is disabled by subscription expiration or plan.";

export type SelectionEntrySource = "cache" | "fresh" | "unavailable";
export type SelectionFallbackReason =
  | "experimental-config-missing"
  | "all-probes-failed"
  | "mixed-probe-outcomes"
  | "all-accounts-exhausted"
  | "ambiguous-usage"
  | null;
export type SelectionDecisionMode =
  | "manual-default"
  | "manual-default-fallback-single"
  | "single-account"
  | "experimental-ranked";
export type SelectionSummaryMode = "display-only" | "execution";

export interface SelectionSummaryEntry {
  account: AccountRecord;
  expiredAt: AccountSubscriptionExpiration;
  paidAt: AccountPaidAt;
  failureCategory: UsageProbeFailureCategory | null;
  failureMessage: string | null;
  isDefault: boolean;
  isDisabledForAutoSelection: boolean;
  isEligibleForRanking: boolean;
  isSelected: boolean;
  rankingPosition: number | null;
  snapshot: NormalizedUsageSnapshot | null;
  source: SelectionEntrySource;
}

export interface SelectionSummary {
  entries: SelectionSummaryEntry[];
  executionBlockedReason: string | null;
  fallbackReason: SelectionFallbackReason;
  mode: SelectionSummaryMode;
  selectedAccount: AccountRecord | null;
  selectedBy: SelectionDecisionMode | null;
  strategy: AccountSelectionStrategy;
}

export async function resolveSelectionSummary(input: {
  experimentalSelection?: ExperimentalSelectionConfig;
  fetchImpl?: typeof fetch;
  logger: Logger;
  mode?: SelectionSummaryMode;
  registry: AccountRegistry;
  selectionCacheFilePath?: string;
  strategy: AccountSelectionStrategy;
}): Promise<SelectionSummary> {
  const mode = input.mode ?? "execution";
  const accounts = await input.registry.listAccounts();
  const accountPresentations = await buildAccountPresentations({
    accounts,
    logger: input.logger,
  });
  const paidAtByAccountId = new Map(
    accountPresentations.map((presentation) => [
      presentation.account.id,
      presentation.paidAt,
    ]),
  );

  input.logger.info("selection.summary.start", {
    mode,
    strategy: input.strategy,
    accountCount: accounts.length,
    paidAtCount: accountPresentations.filter(
      (presentation) => presentation.paidAt.isoValue !== null,
    ).length,
  });

  if (accounts.length === 0) {
    input.logger.warn("selection.none", {
      mode,
      strategy: input.strategy,
    });
    throw new Error("No accounts configured. Add one with `codexes account add <label>`.");
  }

  const expiredAtByAccountId = await resolveExpirationMetadata({
    accounts,
    fetchImpl: input.fetchImpl,
    logger: input.logger,
    mode,
  });
  const defaultAccount = await input.registry.getDefaultAccount();
  const summary = await resolveStrategySummary({
    accounts,
    paidAtByAccountId,
    expiredAtByAccountId,
    defaultAccount,
    experimentalSelection: input.experimentalSelection,
    fetchImpl: input.fetchImpl,
    logger: input.logger,
    mode,
    registry: input.registry,
    selectionCacheFilePath: input.selectionCacheFilePath,
    strategy: input.strategy,
  });

  input.logger.info("selection.summary.complete", {
    mode: summary.mode,
    strategy: summary.strategy,
    selectedAccountId: summary.selectedAccount?.id ?? null,
    selectedBy: summary.selectedBy,
    fallbackReason: summary.fallbackReason,
    executionBlockedReason: summary.executionBlockedReason,
    entryCount: summary.entries.length,
  });

  return summary;
}

async function resolveStrategySummary(input: {
  accounts: AccountRecord[];
  defaultAccount: AccountRecord | null;
  experimentalSelection?: ExperimentalSelectionConfig;
  fetchImpl?: typeof fetch;
  logger: Logger;
  mode: SelectionSummaryMode;
  registry: AccountRegistry;
  selectionCacheFilePath?: string;
  strategy: AccountSelectionStrategy;
  paidAtByAccountId: Map<string, AccountPaidAt>;
  expiredAtByAccountId: Map<string, AccountSubscriptionExpiration>;
}): Promise<SelectionSummary> {
  switch (input.strategy) {
    case "manual-default":
      return buildManualDefaultSummary(
        input.registry,
        input.logger,
        input.accounts,
        input.defaultAccount,
        input.mode,
        input.paidAtByAccountId,
        input.expiredAtByAccountId,
      );
    case "single-account":
      return buildSingleAccountSummary(
        input.registry,
        input.logger,
        input.accounts,
        input.defaultAccount,
        input.mode,
        input.paidAtByAccountId,
        input.expiredAtByAccountId,
      );
    case "remaining-limit":
    case "remaining-limit-experimental":
      return buildExperimentalSummary(input);
  }
}

async function buildManualDefaultSummary(
  registry: AccountRegistry,
  logger: Logger,
  accounts: AccountRecord[],
  defaultAccount: AccountRecord | null,
  mode: SelectionSummaryMode,
  paidAtByAccountId: Map<string, AccountPaidAt>,
  expiredAtByAccountId: Map<string, AccountSubscriptionExpiration>,
): Promise<SelectionSummary> {
  const now = new Date();
  const selection = removeDisabledSelection({
    blockedReason: DISABLED_SELECTION_BLOCKED_REASON,
    disabledRule: "execution",
    expiredAtByAccountId,
    logger,
    now,
    probeResults: [],
    selection: await resolveManualDefaultSelection({
      accounts,
      expiredAtByAccountId,
      logger,
      mode,
      now,
      preselectDisabledRule: "execution",
      registry,
      strategy: "manual-default",
    }),
    selectionDisabledEvent: "selection.manual_default_disabled",
  });

  return {
    entries: createUnavailableEntries(
      accounts,
      defaultAccount,
      selection.selectedAccount,
      paidAtByAccountId,
      expiredAtByAccountId,
    ),
    executionBlockedReason: selection.executionBlockedReason,
    fallbackReason: null,
    mode,
    selectedAccount: selection.selectedAccount,
    selectedBy: selection.selectedBy,
    strategy: "manual-default",
  };
}

async function buildSingleAccountSummary(
  registry: AccountRegistry,
  logger: Logger,
  accounts: AccountRecord[],
  defaultAccount: AccountRecord | null,
  mode: SelectionSummaryMode,
  paidAtByAccountId: Map<string, AccountPaidAt>,
  expiredAtByAccountId: Map<string, AccountSubscriptionExpiration>,
): Promise<SelectionSummary> {
  const now = new Date();
  const selection = removeDisabledSelection({
    blockedReason: DISABLED_SELECTION_BLOCKED_REASON,
    disabledRule: "execution",
    expiredAtByAccountId,
    logger,
    now,
    probeResults: [],
    selection: {
      executionBlockedReason: null,
      selectedAccount: await selectSingleAccountOnly(registry, logger, accounts, mode, {
        disabledRule: "execution",
        expiredAtByAccountId,
        now,
      }),
      selectedBy: "single-account",
    },
    selectionDisabledEvent: "selection.single_account_disabled",
  });

  return {
    entries: createUnavailableEntries(
      accounts,
      defaultAccount,
      selection.selectedAccount,
      paidAtByAccountId,
      expiredAtByAccountId,
    ),
    executionBlockedReason: selection.executionBlockedReason,
    fallbackReason: null,
    mode,
    selectedAccount: selection.selectedAccount,
    selectedBy: selection.selectedBy,
    strategy: "single-account",
  };
}

async function buildExperimentalSummary(input: {
  accounts: AccountRecord[];
  defaultAccount: AccountRecord | null;
  experimentalSelection?: ExperimentalSelectionConfig;
  fetchImpl?: typeof fetch;
  logger: Logger;
  mode: SelectionSummaryMode;
  registry: AccountRegistry;
  selectionCacheFilePath?: string;
  strategy: AccountSelectionStrategy;
  paidAtByAccountId: Map<string, AccountPaidAt>;
  expiredAtByAccountId: Map<string, AccountSubscriptionExpiration>;
}): Promise<SelectionSummary> {
  if (!input.experimentalSelection?.enabled || !input.selectionCacheFilePath) {
    input.logger.warn("selection.experimental_config_missing", {
      enabled: input.experimentalSelection?.enabled ?? false,
      hasSelectionCacheFilePath: Boolean(input.selectionCacheFilePath),
      mode: input.mode,
    });

    const fallbackNow = new Date();
    const fallbackSelection = await resolveManualDefaultSelection({
      accounts: input.accounts,
      expiredAtByAccountId: input.expiredAtByAccountId,
      fallbackReason: "experimental-config-missing",
      logger: input.logger,
      mode: input.mode,
      now: fallbackNow,
      preselectDisabledRule: "auto",
      registry: input.registry,
      strategy: input.strategy,
    });
    const eligibleFallbackSelection = removeDisabledSelection({
      blockedReason: DISABLED_AUTO_SELECTION_BLOCKED_REASON,
      disabledRule: "auto",
      expiredAtByAccountId: input.expiredAtByAccountId,
      logger: input.logger,
      now: fallbackNow,
      probeResults: [],
      selection: fallbackSelection,
      selectionDisabledEvent: "selection.experimental_fallback_disabled",
    });

    return {
      entries: createUnavailableEntries(
        input.accounts,
        input.defaultAccount,
        eligibleFallbackSelection.selectedAccount,
        input.paidAtByAccountId,
        input.expiredAtByAccountId,
      ),
      executionBlockedReason: eligibleFallbackSelection.executionBlockedReason,
      fallbackReason: "experimental-config-missing",
      mode: input.mode,
      selectedAccount: eligibleFallbackSelection.selectedAccount,
      selectedBy: eligibleFallbackSelection.selectedBy,
      strategy: input.strategy,
    };
  }

  const probeResults = await resolveAccountUsageSnapshots({
    accounts: input.accounts,
    cacheFilePath: input.selectionCacheFilePath,
    fetchImpl: input.fetchImpl,
    logger: input.logger,
    probeConfig: input.experimentalSelection,
  });

  const failedProbes = probeResults.filter((entry) => !entry.ok);
  if (failedProbes.length > 0) {
    const fallbackReason =
      failedProbes.length === probeResults.length ? "all-probes-failed" : "mixed-probe-outcomes";
    input.logger.warn(
      fallbackReason === "all-probes-failed"
        ? "selection.experimental_fallback_all_probes_failed"
        : "selection.experimental_fallback_mixed_probe_outcomes",
      {
        failedAccountIds: failedProbes.map((entry) => entry.account.id),
        failureCategories: failedProbes.map((entry) => entry.category),
        mode: input.mode,
        successfulAccountIds: probeResults
          .filter((entry) => entry.ok)
          .map((entry) => entry.account.id),
      },
    );

    const fallbackNow = new Date();
    const fallbackSelection = await resolveManualDefaultSelection({
      accounts: input.accounts,
      expiredAtByAccountId: input.expiredAtByAccountId,
      fallbackReason,
      logger: input.logger,
      mode: input.mode,
      now: fallbackNow,
      preselectDisabledRule: "auto",
      registry: input.registry,
      strategy: input.strategy,
    });
    const eligibleFallbackSelection = removeDisabledSelection({
      blockedReason: DISABLED_AUTO_SELECTION_BLOCKED_REASON,
      disabledRule: "auto",
      expiredAtByAccountId: input.expiredAtByAccountId,
      logger: input.logger,
      now: fallbackNow,
      probeResults,
      selection: fallbackSelection,
      selectionDisabledEvent: "selection.experimental_fallback_disabled",
    });
    logExperimentalFallbackSelection(input.logger, {
      fallbackReason,
      mode: input.mode,
      selectedAccount: eligibleFallbackSelection.selectedAccount,
      selectedBy: eligibleFallbackSelection.selectedBy,
    });

    return {
      entries: createExperimentalEntries({
        defaultAccount: input.defaultAccount,
        probeResults,
        selectedAccount: eligibleFallbackSelection.selectedAccount,
        selectedCandidateIds: [],
        paidAtByAccountId: input.paidAtByAccountId,
        expiredAtByAccountId: input.expiredAtByAccountId,
      }),
      executionBlockedReason: eligibleFallbackSelection.executionBlockedReason,
      fallbackReason,
      mode: input.mode,
      selectedAccount: eligibleFallbackSelection.selectedAccount,
      selectedBy: eligibleFallbackSelection.selectedBy,
      strategy: input.strategy,
    };
  }

  const successfulProbes = probeResults.filter((entry) => entry.ok);
  const now = new Date();
  const candidates = successfulProbes
    .filter((entry) => {
      const expiredAt =
        input.expiredAtByAccountId.get(entry.account.id) ?? emptyExpiration("summary-missing");
      if (entry.snapshot.status !== "usable") {
        return false;
      }

      const disabledReason = resolveAutoSelectionDisabledReason({
        expiredAt,
        now,
        snapshot: entry.snapshot,
      });
      if (!disabledReason) {
        return true;
      }

      input.logger.debug("selection.experimental_candidate_disabled", {
        accountId: entry.account.id,
        label: entry.account.label,
        plan: resolveSubscriptionPlanForAutoSelection(expiredAt, entry.snapshot),
        reason: disabledReason,
        source: entry.source,
        subscriptionExpirationIso: expiredAt.isoValue,
      });
      return false;
    })
    .sort((left, right) =>
      compareExperimentalCandidates({
        defaultAccountId: input.defaultAccount?.id ?? null,
        left,
        registryOrder: input.accounts,
        right,
      }),
    );

  input.logger.info("selection.experimental_ranked", {
    candidateOrder: candidates.map((entry) => ({
      accountId: entry.account.id,
      label: entry.account.label,
      primaryRemainingPercent: entry.snapshot.dailyRemaining,
      secondaryRemainingPercent: entry.snapshot.weeklyRemaining,
      source: entry.source,
    })),
    defaultAccountId: input.defaultAccount?.id ?? null,
    mode: input.mode,
    rankingSignal: "remaining-percent",
    tieBreakOrder: [
      "primary_remaining_percent_desc",
      "secondary_remaining_percent_desc",
      "default_account",
      "registry_order",
    ],
  });

  const selected = candidates[0];
  if (!selected) {
    const allExhausted = successfulProbes.every(
      (entry) => entry.snapshot.limitReached || entry.snapshot.status === "limit-reached",
    );
    const fallbackReason = allExhausted ? "all-accounts-exhausted" : "ambiguous-usage";
    input.logger.warn(
      allExhausted
        ? "selection.experimental_fallback_all_accounts_exhausted"
        : "selection.experimental_fallback_ambiguous_usage",
      {
        mode: input.mode,
        usableProbeCount: candidates.length,
        probeStatuses: successfulProbes.map((entry) => ({
          accountId: entry.account.id,
          snapshotStatus: entry.snapshot.status,
          limitReached: entry.snapshot.limitReached,
          dailyRemaining: entry.snapshot.dailyRemaining,
          weeklyRemaining: entry.snapshot.weeklyRemaining,
        })),
      },
    );

    const fallbackSelection = await resolveManualDefaultSelection({
      accounts: input.accounts,
      expiredAtByAccountId: input.expiredAtByAccountId,
      fallbackReason,
      logger: input.logger,
      mode: input.mode,
      now,
      preselectDisabledRule: "auto",
      registry: input.registry,
      strategy: input.strategy,
    });
    const eligibleFallbackSelection = removeDisabledSelection({
      blockedReason: DISABLED_AUTO_SELECTION_BLOCKED_REASON,
      disabledRule: "auto",
      expiredAtByAccountId: input.expiredAtByAccountId,
      logger: input.logger,
      now,
      probeResults,
      selection: fallbackSelection,
      selectionDisabledEvent: "selection.experimental_fallback_disabled",
    });
    logExperimentalFallbackSelection(input.logger, {
      fallbackReason,
      mode: input.mode,
      selectedAccount: eligibleFallbackSelection.selectedAccount,
      selectedBy: eligibleFallbackSelection.selectedBy,
    });

    return {
      entries: createExperimentalEntries({
        defaultAccount: input.defaultAccount,
        probeResults,
        selectedAccount: eligibleFallbackSelection.selectedAccount,
        selectedCandidateIds: [],
        paidAtByAccountId: input.paidAtByAccountId,
        expiredAtByAccountId: input.expiredAtByAccountId,
      }),
      executionBlockedReason: eligibleFallbackSelection.executionBlockedReason,
      fallbackReason,
      mode: input.mode,
      selectedAccount: eligibleFallbackSelection.selectedAccount,
      selectedBy: eligibleFallbackSelection.selectedBy,
      strategy: input.strategy,
    };
  }

  input.logger.info("selection.experimental_selected", {
    accountId: selected.account.id,
    label: selected.account.label,
    primaryRemainingPercent: selected.snapshot.dailyRemaining,
    secondaryRemainingPercent: selected.snapshot.weeklyRemaining,
    source: selected.source,
    mode: input.mode,
    selectedBy: "experimental-ranked",
    rankingSignal: "remaining-percent",
  });

  return {
    entries: createExperimentalEntries({
      defaultAccount: input.defaultAccount,
      probeResults,
      selectedAccount: selected.account,
      selectedCandidateIds: candidates.map((entry) => entry.account.id),
      paidAtByAccountId: input.paidAtByAccountId,
      expiredAtByAccountId: input.expiredAtByAccountId,
    }),
    executionBlockedReason: null,
    fallbackReason: null,
    mode: input.mode,
    selectedAccount: selected.account,
    selectedBy: "experimental-ranked",
    strategy: input.strategy,
  };
}

async function resolveManualDefaultSelection(input: {
  accounts: AccountRecord[];
  expiredAtByAccountId?: Map<string, AccountSubscriptionExpiration>;
  fallbackReason?: SelectionFallbackReason;
  logger: Logger;
  mode: SelectionSummaryMode;
  now?: Date;
  preselectDisabledRule?: "auto" | "execution";
  registry: AccountRegistry;
  strategy: AccountSelectionStrategy;
}): Promise<{
  executionBlockedReason: string | null;
  selectedAccount: AccountRecord | null;
  selectedBy: "manual-default" | "manual-default-fallback-single" | null;
}> {
  input.logger.debug("selection.manual_default.requirement", {
    mode: input.mode,
    strategy: input.strategy,
    fallbackReason: input.fallbackReason ?? null,
    accountCount: input.accounts.length,
  });

  const defaultAccount = await input.registry.getDefaultAccount();
  if (defaultAccount) {
    if (isPreselectedAccountDisabled(defaultAccount, input)) {
      return {
        executionBlockedReason: null,
        selectedAccount: defaultAccount,
        selectedBy: "manual-default",
      };
    }

    input.logger.info("selection.manual_default", {
      accountId: defaultAccount.id,
      label: defaultAccount.label,
      mode: input.mode,
      strategy: input.strategy,
    });
    return {
      executionBlockedReason: null,
      selectedAccount: defaultAccount,
      selectedBy: "manual-default",
    };
  }

  if (input.accounts.length === 1) {
    const [singleAccount] = input.accounts;
    if (!singleAccount) {
      throw new Error("No accounts configured.");
    }

    if (isPreselectedAccountDisabled(singleAccount, input)) {
      return {
        executionBlockedReason: null,
        selectedAccount: singleAccount,
        selectedBy: "manual-default-fallback-single",
      };
    }

    input.logger.info("selection.manual_default_fallback_single", {
      accountId: singleAccount.id,
      label: singleAccount.label,
      mode: input.mode,
      strategy: input.strategy,
    });

    return {
      executionBlockedReason: null,
      selectedAccount: await input.registry.selectAccount(singleAccount.id),
      selectedBy: "manual-default-fallback-single",
    };
  }

  const executionBlockedReason =
    "Multiple accounts are configured but no default account is selected. Use `codexes account use <account-id-or-label>` first.";

  input.logger.warn("selection.manual_default_missing", {
    accountCount: input.accounts.length,
    mode: input.mode,
    strategy: input.strategy,
    fallbackReason: input.fallbackReason ?? null,
  });

  if (input.mode === "display-only") {
    input.logger.info("selection.display_only_missing_execution_account", {
      accountCount: input.accounts.length,
      strategy: input.strategy,
      fallbackReason: input.fallbackReason ?? null,
    });
    return {
      executionBlockedReason,
      selectedAccount: null,
      selectedBy: null,
    };
  }

  input.logger.warn("selection.execution_blocked_missing_default", {
    accountCount: input.accounts.length,
    strategy: input.strategy,
    fallbackReason: input.fallbackReason ?? null,
  });
  throw new Error(executionBlockedReason);
}

async function selectSingleAccountOnly(
  registry: AccountRegistry,
  logger: Logger,
  accounts: AccountRecord[],
  mode: SelectionSummaryMode,
  preselect?: {
    disabledRule: "auto" | "execution";
    expiredAtByAccountId: Map<string, AccountSubscriptionExpiration>;
    now: Date;
  },
): Promise<AccountRecord> {
  logger.debug("selection.single_account.requirement", {
    mode,
    accountCount: accounts.length,
  });

  if (accounts.length !== 1) {
    logger.warn("selection.single_account_invalid", {
      accountCount: accounts.length,
      mode,
    });
    throw new Error(
      "The single-account strategy requires exactly one configured account.",
    );
  }

  const [singleAccount] = accounts;
  if (!singleAccount) {
    throw new Error("No accounts configured.");
  }

  if (
    preselect &&
    isPreselectedAccountDisabled(singleAccount, {
      expiredAtByAccountId: preselect.expiredAtByAccountId,
      now: preselect.now,
      preselectDisabledRule: preselect.disabledRule,
    })
  ) {
    return singleAccount;
  }

  logger.info("selection.single_account", {
    accountId: singleAccount.id,
    label: singleAccount.label,
    mode,
  });

  const defaultAccount = await registry.getDefaultAccount();
  if (defaultAccount?.id === singleAccount.id) {
    return singleAccount;
  }

  return registry.selectAccount(singleAccount.id);
}

function isPreselectedAccountDisabled(
  account: AccountRecord,
  input: {
    expiredAtByAccountId?: Map<string, AccountSubscriptionExpiration>;
    now?: Date;
    preselectDisabledRule?: "auto" | "execution";
  },
): boolean {
  if (!input.expiredAtByAccountId || !input.preselectDisabledRule) {
    return false;
  }

  const expiredAt = input.expiredAtByAccountId.get(account.id) ?? emptyExpiration("summary-missing");
  const disabledReason =
    input.preselectDisabledRule === "auto"
      ? resolveAutoSelectionDisabledReason({
          expiredAt,
          now: input.now ?? new Date(),
          snapshot: null,
        })
      : resolveExecutionSelectionDisabledReason({
          expiredAt,
          now: input.now ?? new Date(),
          snapshot: null,
        });

  return disabledReason !== null;
}

function createUnavailableEntries(
  accounts: AccountRecord[],
  defaultAccount: AccountRecord | null,
  selectedAccount: AccountRecord | null,
  paidAtByAccountId: Map<string, AccountPaidAt>,
  expiredAtByAccountId: Map<string, AccountSubscriptionExpiration>,
): SelectionSummaryEntry[] {
  const now = new Date();
  return accounts.map((account) => {
    const expiredAt = expiredAtByAccountId.get(account.id) ?? emptyExpiration("summary-missing");

    return {
      account,
      expiredAt,
      paidAt: paidAtByAccountId.get(account.id) ?? {
        displayValue: null,
        isoValue: null,
        source: "summary-missing",
      },
      failureCategory: null,
      failureMessage: null,
      isDefault: account.id === defaultAccount?.id,
      isDisabledForAutoSelection: isDisabledForAutoSelection({
        expiredAt,
        now,
        snapshot: null,
      }),
      isEligibleForRanking: false,
      isSelected: account.id === selectedAccount?.id,
      rankingPosition: null,
      snapshot: null,
      source: "unavailable",
    };
  });
}

function createExperimentalEntries(input: {
  defaultAccount: AccountRecord | null;
  probeResults: AccountUsageResolution[];
  selectedAccount: AccountRecord | null;
  selectedCandidateIds: string[];
  paidAtByAccountId: Map<string, AccountPaidAt>;
  expiredAtByAccountId: Map<string, AccountSubscriptionExpiration>;
}): SelectionSummaryEntry[] {
  const now = new Date();
  return input.probeResults.map((entry) => {
    const expiredAt =
      input.expiredAtByAccountId.get(entry.account.id) ?? emptyExpiration("summary-missing");
    const snapshot = entry.ok ? entry.snapshot : null;
    const isDisabledForAutoSelectionEntry = isDisabledForAutoSelection({
      expiredAt,
      now,
      snapshot,
    });

    return {
      account: entry.account,
      expiredAt,
      paidAt: input.paidAtByAccountId.get(entry.account.id) ?? {
        displayValue: null,
        isoValue: null,
        source: "summary-missing",
      },
      failureCategory: entry.ok ? null : entry.category,
      failureMessage: entry.ok ? null : entry.message,
      isDefault: entry.account.id === input.defaultAccount?.id,
      isDisabledForAutoSelection: isDisabledForAutoSelectionEntry,
      isEligibleForRanking:
        entry.ok && entry.snapshot.status === "usable" && !isDisabledForAutoSelectionEntry,
      isSelected: entry.account.id === input.selectedAccount?.id,
      rankingPosition: entry.ok ? resolveRankingPosition(input.selectedCandidateIds, entry.account.id) : null,
      snapshot,
      source: entry.ok ? entry.source : "fresh",
    };
  });
}

async function resolveExpirationMetadata(input: {
  accounts: AccountRecord[];
  fetchImpl?: typeof fetch;
  logger: Logger;
  mode: SelectionSummaryMode;
}): Promise<Map<string, AccountSubscriptionExpiration>> {
  input.logger.info("selection.expiration_summary.start", {
    accountCount: input.accounts.length,
    mode: input.mode,
  });

  const results = await Promise.all(
    input.accounts.map(async (account) => ({
      accountId: account.id,
      expiredAt: await resolveAccountSubscriptionExpiration({
        account,
        fetchImpl: input.fetchImpl,
        logger: input.logger,
      }),
    })),
  );
  const emptyResultCount = results.filter(
    ({ expiredAt }) => !expiredAt.displayValue || !expiredAt.isoValue,
  ).length;

  input.logger.debug("selection.expiration_summary.complete", {
    accountCount: input.accounts.length,
    emptyResultCount,
    mode: input.mode,
    resolvedCount: results.length - emptyResultCount,
  });

  return new Map(results.map(({ accountId, expiredAt }) => [accountId, expiredAt]));
}

function emptyExpiration(source: string): AccountSubscriptionExpiration {
  return {
    displayValue: null,
    isoValue: null,
    plan: null,
    source,
  };
}

function isDisabledForAutoSelection(input: {
  expiredAt: AccountSubscriptionExpiration;
  now: Date;
  snapshot: NormalizedUsageSnapshot | null;
}): boolean {
  return resolveAutoSelectionDisabledReason(input) !== null;
}

function isExpiredForAutoSelection(
  expiredAt: AccountSubscriptionExpiration,
  now: Date,
): boolean {
  if (!expiredAt.isoValue) {
    return false;
  }

  const expirationDate = new Date(expiredAt.isoValue);
  if (Number.isNaN(expirationDate.getTime())) {
    return false;
  }

  return expirationDate.getTime() <= now.getTime();
}

function resolveAutoSelectionDisabledReason(input: {
  expiredAt: AccountSubscriptionExpiration;
  now: Date;
  snapshot: NormalizedUsageSnapshot | null;
}): "expired" | "free_plan" | null {
  if (isExpiredForAutoSelection(input.expiredAt, input.now)) {
    return "expired";
  }

  const plan = resolveSubscriptionPlanForAutoSelection(input.expiredAt, input.snapshot);
  if (!plan) {
    return null;
  }

  return plan === "free" ? "free_plan" : null;
}

function resolveExecutionSelectionDisabledReason(input: {
  expiredAt: AccountSubscriptionExpiration;
  now: Date;
  snapshot: NormalizedUsageSnapshot | null;
}): "expired" | "free_plan" | null {
  if (isExpiredForAutoSelection(input.expiredAt, input.now)) {
    return "expired";
  }

  return resolveSubscriptionPlanForAutoSelection(input.expiredAt, input.snapshot) === "free"
    ? "free_plan"
    : null;
}

function resolveSubscriptionPlanForAutoSelection(
  expiredAt: AccountSubscriptionExpiration,
  snapshot: NormalizedUsageSnapshot | null,
): string | null {
  const subscriptionPlan = expiredAt.plan?.trim().toLowerCase();
  if (subscriptionPlan) {
    return subscriptionPlan;
  }

  const usagePlan = snapshot?.plan?.trim().toLowerCase();
  return usagePlan || null;
}

function resolveRankingPosition(selectedCandidateIds: string[], accountId: string): number | null {
  const index = selectedCandidateIds.indexOf(accountId);
  if (index < 0) {
    return null;
  }

  return index + 1;
}

function removeDisabledSelection(input: {
  blockedReason: string;
  disabledRule: "auto" | "execution";
  expiredAtByAccountId: Map<string, AccountSubscriptionExpiration>;
  selection: {
    executionBlockedReason: string | null;
    selectedAccount: AccountRecord | null;
    selectedBy: SelectionDecisionMode | null;
  };
  logger: Logger;
  now: Date;
  probeResults: AccountUsageResolution[];
  selectionDisabledEvent: string;
}): {
  executionBlockedReason: string | null;
  selectedAccount: AccountRecord | null;
  selectedBy: SelectionDecisionMode | null;
} {
  const selectedAccount = input.selection.selectedAccount;
  if (!selectedAccount) {
    return input.selection;
  }

  const probeResult = input.probeResults.find((entry) => entry.account.id === selectedAccount.id);
  const snapshot = probeResult?.ok ? probeResult.snapshot : null;
  const expiredAt =
    input.expiredAtByAccountId.get(selectedAccount.id) ?? emptyExpiration("summary-missing");

  const disabledReason =
    input.disabledRule === "auto"
      ? resolveAutoSelectionDisabledReason({
          expiredAt,
          now: input.now,
          snapshot,
        })
      : resolveExecutionSelectionDisabledReason({
          expiredAt,
          now: input.now,
          snapshot,
        });

  if (!disabledReason) {
    return input.selection;
  }

  input.logger.debug(input.selectionDisabledEvent, {
    accountId: selectedAccount.id,
    label: selectedAccount.label,
    plan: resolveSubscriptionPlanForAutoSelection(expiredAt, snapshot),
    reason: disabledReason,
    subscriptionExpirationIso: expiredAt.isoValue,
  });

  return {
    executionBlockedReason: input.blockedReason,
    selectedAccount: null,
    selectedBy: null,
  };
}

function compareExperimentalCandidates(input: {
  defaultAccountId: string | null;
  left: {
    account: AccountRecord;
    snapshot: {
      dailyRemaining: number | null;
      weeklyRemaining: number | null;
    };
  };
  registryOrder: AccountRecord[];
  right: {
    account: AccountRecord;
    snapshot: {
      dailyRemaining: number | null;
      weeklyRemaining: number | null;
    };
  };
}): number {
  const dailyDelta =
    (input.right.snapshot.dailyRemaining ?? Number.NEGATIVE_INFINITY) -
    (input.left.snapshot.dailyRemaining ?? Number.NEGATIVE_INFINITY);
  if (dailyDelta !== 0) {
    return dailyDelta;
  }

  const weeklyDelta =
    (input.right.snapshot.weeklyRemaining ?? Number.NEGATIVE_INFINITY) -
    (input.left.snapshot.weeklyRemaining ?? Number.NEGATIVE_INFINITY);
  if (weeklyDelta !== 0) {
    return weeklyDelta;
  }

  const leftIsDefault = input.left.account.id === input.defaultAccountId;
  const rightIsDefault = input.right.account.id === input.defaultAccountId;
  if (leftIsDefault !== rightIsDefault) {
    return leftIsDefault ? -1 : 1;
  }

  return (
    input.registryOrder.findIndex((account) => account.id === input.left.account.id) -
    input.registryOrder.findIndex((account) => account.id === input.right.account.id)
  );
}

function logExperimentalFallbackSelection(
  logger: Logger,
  input: {
    fallbackReason: SelectionFallbackReason;
    mode: SelectionSummaryMode;
    selectedAccount: AccountRecord | null;
    selectedBy: SelectionDecisionMode | null;
  },
): void {
  logger.info("selection.experimental_fallback_selected", {
    fallbackReason: input.fallbackReason,
    mode: input.mode,
    selectedAccountId: input.selectedAccount?.id ?? null,
    selectedBy: input.selectedBy,
    rankingSignal: input.selectedBy === null ? null : "manual-default-fallback",
  });
}
