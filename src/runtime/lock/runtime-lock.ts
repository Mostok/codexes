import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Logger } from "../../logging/logger.js";
import { assertPathInsideRoot, assertSafeAccountId } from "../runtime-contract.js";

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export interface RuntimeLock {
  release(): Promise<void>;
}

export async function acquireRuntimeLock(input: {
  logger: Logger;
  runtimeRoot: string;
  pollIntervalMs?: number;
  staleLockMs?: number;
  waitTimeoutMs?: number;
}): Promise<RuntimeLock> {
  const lockRoot = path.join(input.runtimeRoot, "lock");
  assertPathInsideRoot(lockRoot, input.runtimeRoot, "runtimeLock");

  return acquireDirectoryLock({
    eventPrefix: "runtime_lock",
    lockRoot,
    logger: input.logger,
    pollIntervalMs: input.pollIntervalMs,
    staleLockMs: input.staleLockMs,
    timeoutMessage: `Timed out waiting for the shared runtime lock after ${
      input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    }ms.`,
    waitTimeoutMs: input.waitTimeoutMs,
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export async function acquireAccountSyncLock(input: {
  accountId: string;
  logger: Logger;
  runtimeRoot: string;
  pollIntervalMs?: number;
  staleLockMs?: number;
  waitTimeoutMs?: number;
}): Promise<RuntimeLock> {
  assertSafeAccountId(input.accountId);
  const lockRoot = path.join(input.runtimeRoot, "locks", "account", input.accountId, "sync.lock");
  assertPathInsideRoot(lockRoot, input.runtimeRoot, "accountSyncLock");
  await mkdir(path.dirname(lockRoot), { recursive: true });

  return acquireDirectoryLock({
    eventPrefix: "account_sync_lock",
    lockRoot,
    logger: input.logger,
    ownerDetails: {
      accountId: input.accountId,
    },
    pollIntervalMs: input.pollIntervalMs,
    staleLockMs: input.staleLockMs,
    timeoutMessage: `Timed out waiting for account "${input.accountId}" sync lock after ${
      input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    }ms.`,
    waitTimeoutMs: input.waitTimeoutMs,
  });
}

export async function acquireSharedSyncLock(input: {
  logger: Logger;
  runtimeRoot: string;
  pollIntervalMs?: number;
  staleLockMs?: number;
  waitTimeoutMs?: number;
}): Promise<RuntimeLock> {
  const lockRoot = path.join(input.runtimeRoot, "locks", "shared", "sync.lock");
  assertPathInsideRoot(lockRoot, input.runtimeRoot, "sharedSyncLock");
  await mkdir(path.dirname(lockRoot), { recursive: true });

  return acquireDirectoryLock({
    eventPrefix: "shared_sync_lock",
    lockRoot,
    logger: input.logger,
    pollIntervalMs: input.pollIntervalMs,
    staleLockMs: input.staleLockMs,
    timeoutMessage: `Timed out waiting for shared sync lock after ${
      input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    }ms.`,
    waitTimeoutMs: input.waitTimeoutMs,
  });
}

async function acquireDirectoryLock(input: {
  eventPrefix: string;
  lockRoot: string;
  logger: Logger;
  ownerDetails?: Record<string, unknown>;
  pollIntervalMs?: number;
  staleLockMs?: number;
  timeoutMessage: string;
  waitTimeoutMs?: number;
}): Promise<RuntimeLock> {
  const ownerFile = path.join(input.lockRoot, "owner.json");
  const waitTimeoutMs = input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const staleLockMs = input.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAt = Date.now();
  const ownerToken = randomUUID();

  input.logger.info(`${input.eventPrefix}.acquire.start`, {
    lockRoot: input.lockRoot,
    waitTimeoutMs,
    staleLockMs,
    pollIntervalMs,
    ...input.ownerDetails,
  });

  while (true) {
    try {
      await mkdir(input.lockRoot, { recursive: false });
      const owner = {
        token: ownerToken,
        pid: process.pid,
        host: os.hostname(),
        createdAt: new Date().toISOString(),
        ...input.ownerDetails,
      };
      await writeFile(ownerFile, JSON.stringify(owner, null, 2), "utf8");

      input.logger.info(`${input.eventPrefix}.acquire.complete`, {
        lockRoot: input.lockRoot,
        waitedMs: Date.now() - startedAt,
        owner,
      });

      return {
        async release() {
          input.logger.info(`${input.eventPrefix}.release.start`, { lockRoot: input.lockRoot });
          await removeLockIfOwned({
            eventPrefix: input.eventPrefix,
            lockRoot: input.lockRoot,
            logger: input.logger,
            ownerToken,
          });
          input.logger.info(`${input.eventPrefix}.release.complete`, { lockRoot: input.lockRoot });
        },
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        input.logger.error(`${input.eventPrefix}.acquire.failed`, {
          lockRoot: input.lockRoot,
          message: error instanceof Error ? error.message : String(error),
          ...input.ownerDetails,
        });
        throw error;
      }
    }

    const owner = await readLockOwner({
      eventPrefix: input.eventPrefix,
      lockRoot: input.lockRoot,
      logger: input.logger,
      ownerDetails: input.ownerDetails,
      ownerFile,
    });
    const lockAgeMs = await resolveLockAgeMs(input.lockRoot, owner.record);
    if (lockAgeMs !== null && lockAgeMs > staleLockMs) {
      input.logger.warn(`${input.eventPrefix}.stale_detected`, {
        lockRoot: input.lockRoot,
        lockAgeMs,
        ownerToken: owner.record?.token ?? null,
        ownerReadState: owner.state,
        ...input.ownerDetails,
      });
      await removeStaleLockIfUnchanged({
        detectedOwner: owner,
        eventPrefix: input.eventPrefix,
        lockRoot: input.lockRoot,
        logger: input.logger,
        ownerDetails: input.ownerDetails,
        staleLockMs,
      });
      continue;
    }

    const waitedMs = Date.now() - startedAt;
    input.logger.debug(`${input.eventPrefix}.acquire.waiting`, {
      lockRoot: input.lockRoot,
      waitedMs,
      lockAgeMs,
      ...input.ownerDetails,
    });

    if (waitedMs >= waitTimeoutMs) {
      input.logger.error(`${input.eventPrefix}.acquire.timeout`, {
        lockRoot: input.lockRoot,
        waitedMs,
        lockAgeMs,
        ...input.ownerDetails,
      });
      throw new Error(input.timeoutMessage);
    }

    await sleep(pollIntervalMs);
  }
}

interface LockOwnerRecord {
  createdAt?: string;
  token?: string;
}

type LockOwnerReadState = "missing" | "readable" | "malformed" | "unreadable";

interface LockOwnerReadResult {
  record: LockOwnerRecord | null;
  state: LockOwnerReadState;
}

async function readLockOwner(input: {
  eventPrefix: string;
  lockRoot: string;
  logger: Logger;
  ownerDetails?: Record<string, unknown>;
  ownerFile: string;
}): Promise<LockOwnerReadResult> {
  let ownerContents: string;
  try {
    ownerContents = await readFile(input.ownerFile, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return { record: null, state: "missing" };
    }

    input.logger.warn(`${input.eventPrefix}.owner_unreadable`, {
      eventPrefix: input.eventPrefix,
      lockRoot: input.lockRoot,
      ownerFile: input.ownerFile,
      reason: error instanceof Error ? error.message : String(error),
      ...input.ownerDetails,
    });
    return { record: null, state: "unreadable" };
  }

  try {
    return { record: JSON.parse(ownerContents) as LockOwnerRecord, state: "readable" };
  } catch (error) {
    input.logger.warn(`${input.eventPrefix}.owner_malformed`, {
      eventPrefix: input.eventPrefix,
      lockRoot: input.lockRoot,
      ownerFile: input.ownerFile,
      reason: error instanceof Error ? error.message : String(error),
      ...input.ownerDetails,
    });
    return { record: null, state: "malformed" };
  }
}

async function resolveLockAgeMs(
  lockRoot: string,
  owner: LockOwnerRecord | null,
): Promise<number | null> {
  if (typeof owner?.createdAt === "string") {
    const createdAtMs = new Date(owner.createdAt).getTime();
    if (Number.isFinite(createdAtMs)) {
      return Date.now() - createdAtMs;
    }
  }

  const lockStats = await stat(lockRoot).catch(() => null);
  return lockStats ? Date.now() - lockStats.mtimeMs : null;
}

async function removeLockIfOwned(input: {
  eventPrefix: string;
  lockRoot: string;
  logger: Logger;
  ownerToken?: string;
}): Promise<boolean> {
  if (!input.ownerToken) {
    input.logger.debug(`${input.eventPrefix}.release.skipped`, {
      lockRoot: input.lockRoot,
      reason: "missing-owner-token",
    });
    return false;
  }

  const ownerFile = path.join(input.lockRoot, "owner.json");
  const currentOwner = await readLockOwner({
    eventPrefix: input.eventPrefix,
    lockRoot: input.lockRoot,
    logger: input.logger,
    ownerFile,
  });
  if (currentOwner.record?.token !== input.ownerToken) {
    input.logger.debug(`${input.eventPrefix}.release.skipped`, {
      lockRoot: input.lockRoot,
      reason: "owner-changed",
      expectedOwnerToken: input.ownerToken,
      currentOwnerToken: currentOwner.record?.token ?? null,
    });
    return false;
  }

  await rm(input.lockRoot, { force: true, recursive: true }).catch(() => undefined);
  return true;
}

async function removeStaleLockIfUnchanged(input: {
  detectedOwner: LockOwnerReadResult;
  eventPrefix: string;
  lockRoot: string;
  logger: Logger;
  ownerDetails?: Record<string, unknown>;
  staleLockMs: number;
}): Promise<boolean> {
  if (input.detectedOwner.record?.token) {
    const removed = await removeLockIfOwned({
      eventPrefix: input.eventPrefix,
      lockRoot: input.lockRoot,
      logger: input.logger,
      ownerToken: input.detectedOwner.record.token,
    });
    if (removed) {
      input.logger.warn(`${input.eventPrefix}.stale_cleanup_removed`, {
        lockRoot: input.lockRoot,
        ownerToken: input.detectedOwner.record.token,
        reason: "stale-owner-token-matched",
        ...input.ownerDetails,
      });
    }
    return removed;
  }

  const ownerFile = path.join(input.lockRoot, "owner.json");
  const currentOwner = await readLockOwner({
    eventPrefix: input.eventPrefix,
    lockRoot: input.lockRoot,
    logger: input.logger,
    ownerDetails: input.ownerDetails,
    ownerFile,
  });
  const currentLockAgeMs = await resolveLockAgeMs(input.lockRoot, currentOwner.record);

  if (currentLockAgeMs === null || currentLockAgeMs <= input.staleLockMs) {
    input.logger.debug(`${input.eventPrefix}.stale_cleanup_skipped`, {
      lockRoot: input.lockRoot,
      reason: "lock-no-longer-stale",
      lockAgeMs: currentLockAgeMs,
      staleLockMs: input.staleLockMs,
      ownerReadState: currentOwner.state,
      ...input.ownerDetails,
    });
    return false;
  }

  if (currentOwner.record?.token) {
    input.logger.debug(`${input.eventPrefix}.stale_cleanup_skipped`, {
      lockRoot: input.lockRoot,
      reason: "owner-token-present-after-recheck",
      currentOwnerToken: currentOwner.record.token,
      ownerReadState: currentOwner.state,
      ...input.ownerDetails,
    });
    return false;
  }

  input.logger.warn(`${input.eventPrefix}.stale_cleanup_removed`, {
    lockRoot: input.lockRoot,
    lockAgeMs: currentLockAgeMs,
    ownerReadState: currentOwner.state,
    reason: "stale-tokenless-or-unreadable-owner",
    ...input.ownerDetails,
  });
  await rm(input.lockRoot, { force: true, recursive: true }).catch(() => undefined);
  return true;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
