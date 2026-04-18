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
import { resolveAccountUsageSnapshots, type AccountUsageResolution } from "./usage-probe-coordinator.js";
import type { UsageProbeFailureCategory } from "./usage-client.js";
import type { NormalizedUsageSnapshot } from "./usage-types.js";

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
  paidAt: AccountPaidAt;
  failureCategory: UsageProbeFailureCategory | null;
  failureMessage: string | null;
  isDefault: boolean;
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

  const defaultAccount = await input.registry.getDefaultAccount();
  const summary = await resolveStrategySummary({
    accounts,
    paidAtByAccountId,
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
      );
    case "single-account":
      return buildSingleAccountSummary(
        input.registry,
        input.logger,
        input.accounts,
        input.defaultAccount,
        input.mode,
        input.paidAtByAccountId,
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
): Promise<SelectionSummary> {
  const selection = await resolveManualDefaultSelection({
    accounts,
    logger,
    mode,
    registry,
    strategy: "manual-default",
  });

  return {
    entries: createUnavailableEntries(
      accounts,
      defaultAccount,
      selection.selectedAccount,
      paidAtByAccountId,
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
): Promise<SelectionSummary> {
  const selectedAccount = await selectSingleAccountOnly(registry, logger, accounts, mode);

  return {
    entries: createUnavailableEntries(
      accounts,
      defaultAccount,
      selectedAccount,
      paidAtByAccountId,
    ),
    executionBlockedReason: null,
    fallbackReason: null,
    mode,
    selectedAccount,
    selectedBy: "single-account",
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
}): Promise<SelectionSummary> {
  if (!input.experimentalSelection?.enabled || !input.selectionCacheFilePath) {
    input.logger.warn("selection.experimental_config_missing", {
      enabled: input.experimentalSelection?.enabled ?? false,
      hasSelectionCacheFilePath: Boolean(input.selectionCacheFilePath),
      mode: input.mode,
    });

    const fallbackSelection = await resolveManualDefaultSelection({
      accounts: input.accounts,
      fallbackReason: "experimental-config-missing",
      logger: input.logger,
      mode: input.mode,
      registry: input.registry,
      strategy: input.strategy,
    });

    return {
      entries: createUnavailableEntries(
        input.accounts,
        input.defaultAccount,
        fallbackSelection.selectedAccount,
        input.paidAtByAccountId,
      ),
      executionBlockedReason: fallbackSelection.executionBlockedReason,
      fallbackReason: "experimental-config-missing",
      mode: input.mode,
      selectedAccount: fallbackSelection.selectedAccount,
      selectedBy: fallbackSelection.selectedBy,
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

    const fallbackSelection = await resolveManualDefaultSelection({
      accounts: input.accounts,
      fallbackReason,
      logger: input.logger,
      mode: input.mode,
      registry: input.registry,
      strategy: input.strategy,
    });
    logExperimentalFallbackSelection(input.logger, {
      fallbackReason,
      mode: input.mode,
      selectedAccount: fallbackSelection.selectedAccount,
      selectedBy: fallbackSelection.selectedBy,
    });

    return {
      entries: createExperimentalEntries({
        defaultAccount: input.defaultAccount,
        probeResults,
        selectedAccount: fallbackSelection.selectedAccount,
        selectedCandidateIds: [],
        paidAtByAccountId: input.paidAtByAccountId,
      }),
      executionBlockedReason: fallbackSelection.executionBlockedReason,
      fallbackReason,
      mode: input.mode,
      selectedAccount: fallbackSelection.selectedAccount,
      selectedBy: fallbackSelection.selectedBy,
      strategy: input.strategy,
    };
  }

  const successfulProbes = probeResults.filter((entry) => entry.ok);
  const candidates = successfulProbes
    .filter((entry) => entry.snapshot.status === "usable")
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
      fallbackReason,
      logger: input.logger,
      mode: input.mode,
      registry: input.registry,
      strategy: input.strategy,
    });
    logExperimentalFallbackSelection(input.logger, {
      fallbackReason,
      mode: input.mode,
      selectedAccount: fallbackSelection.selectedAccount,
      selectedBy: fallbackSelection.selectedBy,
    });

    return {
      entries: createExperimentalEntries({
        defaultAccount: input.defaultAccount,
        probeResults,
        selectedAccount: fallbackSelection.selectedAccount,
        selectedCandidateIds: [],
        paidAtByAccountId: input.paidAtByAccountId,
      }),
      executionBlockedReason: fallbackSelection.executionBlockedReason,
      fallbackReason,
      mode: input.mode,
      selectedAccount: fallbackSelection.selectedAccount,
      selectedBy: fallbackSelection.selectedBy,
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
  fallbackReason?: SelectionFallbackReason;
  logger: Logger;
  mode: SelectionSummaryMode;
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

function createUnavailableEntries(
  accounts: AccountRecord[],
  defaultAccount: AccountRecord | null,
  selectedAccount: AccountRecord | null,
  paidAtByAccountId: Map<string, AccountPaidAt>,
): SelectionSummaryEntry[] {
  return accounts.map((account) => ({
    account,
    paidAt: paidAtByAccountId.get(account.id) ?? {
      displayValue: null,
      isoValue: null,
      source: "summary-missing",
    },
    failureCategory: null,
    failureMessage: null,
    isDefault: account.id === defaultAccount?.id,
    isEligibleForRanking: false,
    isSelected: account.id === selectedAccount?.id,
    rankingPosition: null,
    snapshot: null,
    source: "unavailable",
  }));
}

function createExperimentalEntries(input: {
  defaultAccount: AccountRecord | null;
  probeResults: AccountUsageResolution[];
  selectedAccount: AccountRecord | null;
  selectedCandidateIds: string[];
  paidAtByAccountId: Map<string, AccountPaidAt>;
}): SelectionSummaryEntry[] {
  return input.probeResults.map((entry) => ({
    account: entry.account,
    paidAt: input.paidAtByAccountId.get(entry.account.id) ?? {
      displayValue: null,
      isoValue: null,
      source: "summary-missing",
    },
    failureCategory: entry.ok ? null : entry.category,
    failureMessage: entry.ok ? null : entry.message,
    isDefault: entry.account.id === input.defaultAccount?.id,
    isEligibleForRanking: entry.ok && entry.snapshot.status === "usable",
    isSelected: entry.account.id === input.selectedAccount?.id,
    rankingPosition: entry.ok ? resolveRankingPosition(input.selectedCandidateIds, entry.account.id) : null,
    snapshot: entry.ok ? entry.snapshot : null,
    source: entry.ok ? entry.source : "fresh",
  }));
}

function resolveRankingPosition(selectedCandidateIds: string[], accountId: string): number | null {
  const index = selectedCandidateIds.indexOf(accountId);
  if (index < 0) {
    return null;
  }

  return index + 1;
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
    selectedBy: "manual-default" | "manual-default-fallback-single" | null;
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
