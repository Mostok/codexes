import type { AccountRecord } from "../accounts/account-registry.js";
import type { ExperimentalSelectionConfig } from "../config/wrapper-config.js";
import type { Logger } from "../logging/logger.js";
import { probeAccountUsage, type AccountUsageProbeResult } from "./usage-client.js";
import {
  loadUsageCache,
  persistUsageCache,
  resolveFreshUsageCacheEntry,
  type UsageCacheEntry,
} from "./usage-cache.js";
import type { NormalizedUsageSnapshot } from "./usage-types.js";

export type AccountUsageResolution =
  | {
      ok: true;
      account: AccountRecord;
      snapshot: NormalizedUsageSnapshot;
      source: "cache" | "fresh";
    }
  | AccountUsageProbeResult;

export async function resolveAccountUsageSnapshots(input: {
  accounts: AccountRecord[];
  cacheFilePath: string;
  fetchImpl?: typeof fetch;
  logger: Logger;
  probeConfig: ExperimentalSelectionConfig;
}): Promise<AccountUsageResolution[]> {
  const now = Date.now();

  input.logger.info("selection.usage_probe_coordinator.start", {
    accountCount: input.accounts.length,
    cacheFilePath: input.cacheFilePath,
    cacheTtlMs: input.probeConfig.cacheTtlMs,
    timeoutMs: input.probeConfig.probeTimeoutMs,
  });

  const cacheEntries = await loadUsageCache({
    cacheFilePath: input.cacheFilePath,
    logger: input.logger,
  });
  const freshCacheEntries: UsageCacheEntry[] = [...cacheEntries];
  const resolutions = await Promise.all(
    input.accounts.map(async (account) => {
      const cached = resolveFreshUsageCacheEntry({
        accountId: account.id,
        entries: freshCacheEntries,
        logger: input.logger,
        now,
        ttlMs: input.probeConfig.cacheTtlMs,
      });
      if (cached) {
        return {
          ok: true as const,
          account,
          snapshot: cached.snapshot,
          source: "cache" as const,
        };
      }

      const fresh = await probeAccountUsage({
        account,
        fetchImpl: input.fetchImpl,
        logger: input.logger,
        probeConfig: input.probeConfig,
      });
      if (fresh.ok) {
        upsertCacheEntry(freshCacheEntries, {
          accountId: account.id,
          accountLabel: account.label,
          cachedAt: new Date(now).toISOString(),
          snapshot: fresh.snapshot,
        });
      }

      return fresh;
    }),
  );

  await persistUsageCache({
    cacheFilePath: input.cacheFilePath,
    entries: freshCacheEntries,
    logger: input.logger,
  });

  input.logger.info("selection.usage_probe_coordinator.complete", {
    accountCount: input.accounts.length,
    cacheHitCount: resolutions.filter((entry) => entry.ok && entry.source === "cache").length,
    freshSuccessCount: resolutions.filter((entry) => entry.ok && entry.source === "fresh").length,
    failureCount: resolutions.filter((entry) => !entry.ok).length,
    resolutionSummary: resolutions.map((entry) =>
      entry.ok
        ? {
            accountId: entry.account.id,
            source: entry.source,
            snapshotStatus: entry.snapshot.status,
            primaryRemainingPercent: entry.snapshot.dailyRemaining,
            secondaryRemainingPercent: entry.snapshot.weeklyRemaining,
          }
        : {
            accountId: entry.account.id,
            source: entry.source,
            failureCategory: entry.category,
          },
    ),
  });

  return resolutions;
}

function upsertCacheEntry(entries: UsageCacheEntry[], nextEntry: UsageCacheEntry): void {
  const existingIndex = entries.findIndex((entry) => entry.accountId === nextEntry.accountId);
  if (existingIndex >= 0) {
    entries.splice(existingIndex, 1, nextEntry);
    return;
  }

  entries.push(nextEntry);
}
