import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logging/logger.js";
import type { NormalizedUsageSnapshot } from "./usage-types.js";

const USAGE_CACHE_SCHEMA_VERSION = 1;

export interface UsageCacheEntry {
  accountId: string;
  accountLabel: string;
  cachedAt: string;
  snapshot: NormalizedUsageSnapshot;
}

interface UsageCacheDocument {
  schemaVersion: number;
  entries: UsageCacheEntry[];
}

export async function loadUsageCache(input: {
  cacheFilePath: string;
  logger: Logger;
}): Promise<UsageCacheEntry[]> {
  try {
    const raw = await readFile(input.cacheFilePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeUsageCacheDocument(parsed);

    input.logger.debug("selection.usage_cache.load_success", {
      cacheFilePath: input.cacheFilePath,
      entryCount: normalized.entries.length,
    });

    return normalized.entries;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      input.logger.debug("selection.usage_cache.missing", {
        cacheFilePath: input.cacheFilePath,
      });
      return [];
    }

    const backupPath = `${input.cacheFilePath}.corrupt-${Date.now()}`;
    await rename(input.cacheFilePath, backupPath).catch(() => undefined);

    input.logger.warn("selection.usage_cache.corrupt", {
      cacheFilePath: input.cacheFilePath,
      backupPath,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function persistUsageCache(input: {
  cacheFilePath: string;
  entries: UsageCacheEntry[];
  logger: Logger;
}): Promise<void> {
  await mkdir(path.dirname(input.cacheFilePath), { recursive: true });

  const document: UsageCacheDocument = {
    schemaVersion: USAGE_CACHE_SCHEMA_VERSION,
    entries: input.entries,
  };
  const tempFile = `${input.cacheFilePath}.tmp`;
  const serialized = JSON.stringify(document, null, 2);

  await writeFile(tempFile, serialized, "utf8");
  await rename(tempFile, input.cacheFilePath);

  input.logger.debug("selection.usage_cache.persisted", {
    cacheFilePath: input.cacheFilePath,
    entryCount: input.entries.length,
  });
}

export function resolveFreshUsageCacheEntry(input: {
  accountId: string;
  entries: UsageCacheEntry[];
  logger: Logger;
  now: number;
  ttlMs: number;
}): UsageCacheEntry | null {
  const entry = input.entries.find((candidate) => candidate.accountId === input.accountId) ?? null;
  if (!entry) {
    input.logger.debug("selection.usage_cache.miss", {
      accountId: input.accountId,
      ttlMs: input.ttlMs,
    });
    return null;
  }

  const ageMs = input.now - new Date(entry.cachedAt).valueOf();
  if (!Number.isFinite(ageMs) || ageMs > input.ttlMs) {
    input.logger.debug("selection.usage_cache.expired", {
      accountId: input.accountId,
      cachedAt: entry.cachedAt,
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
      ttlMs: input.ttlMs,
    });
    return null;
  }

  input.logger.debug("selection.usage_cache.hit", {
    accountId: input.accountId,
    cachedAt: entry.cachedAt,
    ageMs,
    ttlMs: input.ttlMs,
  });
  return entry;
}

function normalizeUsageCacheDocument(value: unknown): UsageCacheDocument {
  if (!isRecord(value)) {
    throw new Error("Usage cache document is not an object.");
  }

  const schemaVersion =
    typeof value.schemaVersion === "number" ? value.schemaVersion : USAGE_CACHE_SCHEMA_VERSION;
  if (schemaVersion !== USAGE_CACHE_SCHEMA_VERSION) {
    throw new Error(`Unsupported usage cache schema version ${schemaVersion}.`);
  }

  const entries = Array.isArray(value.entries)
    ? value.entries.filter(isUsageCacheEntry)
    : [];

  return {
    schemaVersion: USAGE_CACHE_SCHEMA_VERSION,
    entries,
  };
}

function isUsageCacheEntry(value: unknown): value is UsageCacheEntry {
  return (
    isRecord(value) &&
    typeof value.accountId === "string" &&
    typeof value.accountLabel === "string" &&
    typeof value.cachedAt === "string" &&
    isRecord(value.snapshot)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
