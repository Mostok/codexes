import type { AccountRegistry, AccountRecord } from "../accounts/account-registry.js";
import type {
  AccountSelectionStrategy,
  ExperimentalSelectionConfig,
} from "../config/wrapper-config.js";
import type { Logger } from "../logging/logger.js";
import { resolveAccountUsageSnapshots } from "./usage-probe-coordinator.js";

export async function selectAccountForExecution(input: {
  experimentalSelection?: ExperimentalSelectionConfig;
  fetchImpl?: typeof fetch;
  logger: Logger;
  registry: AccountRegistry;
  selectionCacheFilePath?: string;
  strategy: AccountSelectionStrategy;
}): Promise<AccountRecord> {
  const accounts = await input.registry.listAccounts();

  input.logger.info("selection.start", {
    strategy: input.strategy,
    accountCount: accounts.length,
  });

  if (accounts.length === 0) {
    input.logger.warn("selection.none");
    throw new Error("No accounts configured. Add one with `codexes account add <label>`.");
  }

  switch (input.strategy) {
    case "manual-default":
      return selectManualDefaultAccount(input.registry, input.logger, accounts);
    case "single-account":
      return selectSingleAccountOnly(input.registry, input.logger, accounts);
    case "remaining-limit-experimental":
      return selectExperimentalRemainingLimitAccount({
        accounts,
        experimentalSelection: input.experimentalSelection,
        fetchImpl: input.fetchImpl,
        logger: input.logger,
        registry: input.registry,
        selectionCacheFilePath: input.selectionCacheFilePath,
      });
  }
}

async function selectManualDefaultAccount(
  registry: AccountRegistry,
  logger: Logger,
  accounts: AccountRecord[],
): Promise<AccountRecord> {
  const defaultAccount = await registry.getDefaultAccount();
  if (defaultAccount) {
    logger.info("selection.manual_default", {
      accountId: defaultAccount.id,
      label: defaultAccount.label,
    });
    return defaultAccount;
  }

  if (accounts.length === 1) {
    const [singleAccount] = accounts;
    if (!singleAccount) {
      throw new Error("No accounts configured.");
    }

    logger.info("selection.manual_default_fallback_single", {
      accountId: singleAccount.id,
      label: singleAccount.label,
    });
    return registry.selectAccount(singleAccount.id);
  }

  logger.warn("selection.manual_default_missing", {
    accountCount: accounts.length,
  });
  throw new Error(
    "Multiple accounts are configured but no default account is selected. Use `codexes account use <account-id-or-label>` first.",
  );
}

async function selectSingleAccountOnly(
  registry: AccountRegistry,
  logger: Logger,
  accounts: AccountRecord[],
): Promise<AccountRecord> {
  if (accounts.length !== 1) {
    logger.warn("selection.single_account_invalid", {
      accountCount: accounts.length,
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
  });

  const defaultAccount = await registry.getDefaultAccount();
  if (defaultAccount?.id === singleAccount.id) {
    return singleAccount;
  }

  return registry.selectAccount(singleAccount.id);
}

async function selectExperimentalRemainingLimitAccount(input: {
  accounts: AccountRecord[];
  experimentalSelection?: ExperimentalSelectionConfig;
  fetchImpl?: typeof fetch;
  logger: Logger;
  registry: AccountRegistry;
  selectionCacheFilePath?: string;
}): Promise<AccountRecord> {
  if (!input.experimentalSelection?.enabled || !input.selectionCacheFilePath) {
    input.logger.warn("selection.experimental_config_missing", {
      enabled: input.experimentalSelection?.enabled ?? false,
      hasSelectionCacheFilePath: Boolean(input.selectionCacheFilePath),
    });
    return selectManualDefaultAccount(input.registry, input.logger, input.accounts);
  }

  const defaultAccount = await input.registry.getDefaultAccount();
  const probeResults = await resolveAccountUsageSnapshots({
    accounts: input.accounts,
    cacheFilePath: input.selectionCacheFilePath,
    fetchImpl: input.fetchImpl,
    logger: input.logger,
    probeConfig: input.experimentalSelection,
  });

  const failedProbes = probeResults.filter((entry) => !entry.ok);
  if (failedProbes.length > 0) {
    const eventName =
      failedProbes.length === probeResults.length
        ? "selection.experimental_fallback_all_probes_failed"
        : "selection.experimental_fallback_mixed_probe_outcomes";
    input.logger.warn(eventName, {
      failedAccountIds: failedProbes.map((entry) => entry.account.id),
      failureCategories: failedProbes.map((entry) => entry.category),
      successfulAccountIds: probeResults
        .filter((entry) => entry.ok)
        .map((entry) => entry.account.id),
    });
    return selectManualDefaultAccount(input.registry, input.logger, input.accounts);
  }

  const successfulProbes = probeResults.filter((entry) => entry.ok);
  const candidates = successfulProbes
    .filter((entry) => entry.snapshot.status === "usable")
    .sort((left, right) =>
      compareExperimentalCandidates({
        defaultAccountId: defaultAccount?.id ?? null,
        left,
        right,
        registryOrder: input.accounts,
      }),
    );

  input.logger.info("selection.experimental_ranked", {
    candidateOrder: candidates.map((entry) => ({
      accountId: entry.account.id,
      label: entry.account.label,
      dailyRemaining: entry.snapshot.dailyRemaining,
      weeklyRemaining: entry.snapshot.weeklyRemaining,
      source: entry.source,
    })),
    defaultAccountId: defaultAccount?.id ?? null,
  });

  const selected = candidates[0];
  if (!selected) {
    const allExhausted = successfulProbes.every(
      (entry) => entry.snapshot.limitReached || entry.snapshot.status === "limit-reached",
    );
    input.logger.warn(
      allExhausted
        ? "selection.experimental_fallback_all_accounts_exhausted"
        : "selection.experimental_fallback_ambiguous_usage",
      {
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
    return selectManualDefaultAccount(input.registry, input.logger, input.accounts);
  }

  input.logger.info("selection.experimental_selected", {
    accountId: selected.account.id,
    label: selected.account.label,
    dailyRemaining: selected.snapshot.dailyRemaining,
    weeklyRemaining: selected.snapshot.weeklyRemaining,
    source: selected.source,
  });

  return selected.account;
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
