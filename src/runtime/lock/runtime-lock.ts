import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Logger } from "../../logging/logger.js";

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
  const ownerFile = path.join(lockRoot, "owner.json");
  const waitTimeoutMs = input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const staleLockMs = input.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAt = Date.now();

  input.logger.info("runtime_lock.acquire.start", {
    lockRoot,
    waitTimeoutMs,
    staleLockMs,
    pollIntervalMs,
  });

  while (true) {
    try {
      await mkdir(lockRoot);
      const owner = {
        pid: process.pid,
        host: os.hostname(),
        createdAt: new Date().toISOString(),
      };
      await writeFile(ownerFile, JSON.stringify(owner, null, 2), "utf8");

      input.logger.info("runtime_lock.acquire.complete", {
        lockRoot,
        waitedMs: Date.now() - startedAt,
        owner,
      });

      return {
        async release() {
          input.logger.info("runtime_lock.release.start", { lockRoot });
          await rm(lockRoot, { force: true, recursive: true }).catch(() => undefined);
          input.logger.info("runtime_lock.release.complete", { lockRoot });
        },
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        input.logger.error("runtime_lock.acquire.failed", {
          lockRoot,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    const lockAgeMs = await readLockAgeMs(lockRoot, ownerFile);
    if (lockAgeMs !== null && lockAgeMs > staleLockMs) {
      input.logger.warn("runtime_lock.stale_detected", {
        lockRoot,
        lockAgeMs,
      });
      await rm(lockRoot, { force: true, recursive: true }).catch(() => undefined);
      continue;
    }

    const waitedMs = Date.now() - startedAt;
    input.logger.debug("runtime_lock.acquire.waiting", {
      lockRoot,
      waitedMs,
      lockAgeMs,
    });

    if (waitedMs >= waitTimeoutMs) {
      input.logger.error("runtime_lock.acquire.timeout", {
        lockRoot,
        waitedMs,
        lockAgeMs,
      });
      throw new Error(
        `Timed out waiting for the shared runtime lock after ${waitTimeoutMs}ms.`,
      );
    }

    await sleep(pollIntervalMs);
  }
}

async function readLockAgeMs(lockRoot: string, ownerFile: string): Promise<number | null> {
  const ownerContents = await readFile(ownerFile, "utf8").catch(() => null);
  if (ownerContents) {
    const parsed = JSON.parse(ownerContents) as Record<string, unknown>;
    if (typeof parsed.createdAt === "string") {
      return Date.now() - new Date(parsed.createdAt).getTime();
    }
  }

  const lockStats = await stat(lockRoot).catch(() => null);
  return lockStats ? Date.now() - lockStats.mtimeMs : null;
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
