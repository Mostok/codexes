import type { AccountRegistry, AccountRecord } from "../accounts/account-registry.js";
import type {
  AccountSelectionStrategy,
  ExperimentalSelectionConfig,
} from "../config/wrapper-config.js";
import type { Logger } from "../logging/logger.js";
import { resolveSelectionSummary } from "./selection-summary.js";

export async function selectAccountForExecution(input: {
  experimentalSelection?: ExperimentalSelectionConfig;
  fetchImpl?: typeof fetch;
  logger: Logger;
  registry: AccountRegistry;
  selectionCacheFilePath?: string;
  strategy: AccountSelectionStrategy;
}): Promise<AccountRecord> {
  const summary = await resolveSelectionSummary({
    ...input,
    mode: "execution",
  });
  if (!summary.selectedAccount) {
    throw new Error(
      summary.executionBlockedReason ?? "Execution selection did not resolve an account.",
    );
  }

  return summary.selectedAccount;
}
