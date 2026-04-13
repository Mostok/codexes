import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { acquireRuntimeLock } from "../src/runtime/lock/runtime-lock.js";
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
