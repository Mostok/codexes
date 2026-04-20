import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  acquireAccountSyncLock,
  acquireRuntimeLock,
} from "../src/runtime/lock/runtime-lock.js";
import {
  assertEvent,
  createTempDir,
  createTestLogger,
  removeTempDir,
} from "./test-helpers.js";

test("runtime lock times out when another process holds the lock", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-lock");
  t.after(async () => removeTempDir(tempRoot));

  const firstLogger = createTestLogger();
  const secondLogger = createTestLogger();
  const runtimeRoot = path.join(tempRoot, "runtime");
  await mkdir(runtimeRoot, { recursive: true });

  const lock = await acquireRuntimeLock({
    logger: firstLogger.logger,
    pollIntervalMs: 25,
    runtimeRoot,
    waitTimeoutMs: 250,
  });
  t.after(async () => lock.release());

  await assert.rejects(
    () =>
      acquireRuntimeLock({
        logger: secondLogger.logger,
        pollIntervalMs: 25,
        runtimeRoot,
        waitTimeoutMs: 150,
      }),
    /Timed out waiting for the shared runtime lock/i,
  );

  assertEvent(secondLogger.events, "runtime_lock.acquire.timeout", "error");
});

test("runtime lock recovers stale lock directories", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-lock-stale");
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  const runtimeRoot = path.join(tempRoot, "runtime");
  const lockRoot = path.join(runtimeRoot, "lock");
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(lockRoot, { recursive: true });
  await writeFile(
    path.join(lockRoot, "owner.json"),
    JSON.stringify({
      pid: 1,
      host: "stale-host",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    }),
    "utf8",
  );

  const lock = await acquireRuntimeLock({
    logger,
    pollIntervalMs: 10,
    runtimeRoot,
    staleLockMs: 100,
    waitTimeoutMs: 500,
  });
  await lock.release();

  assertEvent(events, "runtime_lock.stale_detected", "warn");
  assertEvent(events, "runtime_lock.acquire.complete", "info");
});

test("runtime lock stale cleanup does not remove a lock whose owner changed", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-lock-owner-change");
  t.after(async () => removeTempDir(tempRoot));

  const runtimeRoot = path.join(tempRoot, "runtime");
  const lockRoot = path.join(runtimeRoot, "lock");
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(lockRoot, { recursive: true });
  await writeFile(
    path.join(lockRoot, "owner.json"),
    JSON.stringify({
      pid: 1,
      host: "stale-host",
      token: "stale-owner",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    }),
    "utf8",
  );

  const events: Array<{
    details: Record<string, unknown> | undefined;
    event: string;
    level: "debug" | "info" | "warn" | "error";
  }> = [];
  const logger = {
    debug(event: string, details?: Record<string, unknown>) {
      events.push({ level: "debug", event, details });
    },
    info(event: string, details?: Record<string, unknown>) {
      events.push({ level: "info", event, details });
    },
    warn(event: string, details?: Record<string, unknown>) {
      events.push({ level: "warn", event, details });
      if (event === "runtime_lock.stale_detected") {
        writeFileSync(
          path.join(lockRoot, "owner.json"),
          JSON.stringify({
            pid: 2,
            host: "fresh-host",
            token: "fresh-owner",
            createdAt: new Date().toISOString(),
          }),
          "utf8",
        );
      }
    },
    error(event: string, details?: Record<string, unknown>) {
      events.push({ level: "error", event, details });
    },
  };

  await assert.rejects(
    () =>
      acquireRuntimeLock({
        logger: logger as ReturnType<typeof createTestLogger>["logger"],
        pollIntervalMs: 10,
        runtimeRoot,
        staleLockMs: 100,
        waitTimeoutMs: 80,
      }),
    /Timed out waiting for the shared runtime lock/i,
  );

  assert.ok(await stat(lockRoot).catch(() => null), "lock directory should remain in place");
  assertEvent(events, "runtime_lock.stale_detected", "warn");
  assertEvent(events, "runtime_lock.release.skipped", "debug");
});

test("account sync locks are scoped per account id", async (t) => {
  const tempRoot = await createTempDir("codexes-account-lock-independent");
  t.after(async () => removeTempDir(tempRoot));

  const runtimeRoot = path.join(tempRoot, "runtime");
  const { events, logger } = createTestLogger();

  const firstLock = await acquireAccountSyncLock({
    accountId: "acct-one",
    logger,
    runtimeRoot,
    waitTimeoutMs: 50,
  });

  try {
    const secondLock = await acquireAccountSyncLock({
      accountId: "acct-two",
      logger,
      runtimeRoot,
      waitTimeoutMs: 50,
    });
    await secondLock.release();
  } finally {
    await firstLock.release();
  }

  assertEvent(events, "account_sync_lock.acquire.complete", "info");
  assert.equal(
    events.some((entry) => entry.event === "account_sync_lock.acquire.timeout"),
    false,
  );
});
