import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { AccountRecord } from "../src/accounts/account-registry.js";
import {
  activateAccountIntoSharedRuntime,
  restoreSharedRuntimeFromBackup,
  syncSharedRuntimeBackToAccount,
} from "../src/runtime/activate-account/activate-account.js";
import { createRuntimeContract, resolveAccountRuntimePaths } from "../src/runtime/runtime-contract.js";
import {
  assertEvent,
  createTempDir,
  createTestLogger,
  removeTempDir,
} from "./test-helpers.js";

test("account activation swaps runtime auth, syncs refreshed state, and restores backups", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-activation");
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  const contract = createRuntimeContract({
    accountRoot: path.join(tempRoot, "accounts"),
    credentialStoreMode: "file",
    logger,
    runtimeRoot: path.join(tempRoot, "runtime"),
    sharedCodexHome: path.join(tempRoot, "shared-home"),
  });

  const account: AccountRecord = {
    id: "acct-1",
    label: "work",
    authDirectory: path.join(tempRoot, "accounts", "acct-1"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  const runtimePaths = resolveAccountRuntimePaths(contract, account.id);

  await mkdir(path.join(runtimePaths.accountStateDirectory, "sessions"), { recursive: true });
  await mkdir(path.join(contract.sharedCodexHome, "sessions"), { recursive: true });

  await writeFile(
    path.join(runtimePaths.accountStateDirectory, "auth.json"),
    '{"tokens":{"account_id":"work"},"last_refresh":"old"}\n',
    "utf8",
  );
  await writeFile(
    path.join(runtimePaths.accountStateDirectory, "sessions", "active.json"),
    '{"session":"account"}\n',
    "utf8",
  );
  await writeFile(
    path.join(contract.sharedCodexHome, "auth.json"),
    '{"tokens":{"account_id":"shared"},"last_refresh":"shared"}\n',
    "utf8",
  );
  await writeFile(
    path.join(contract.sharedCodexHome, "sessions", "active.json"),
    '{"session":"shared"}\n',
    "utf8",
  );

  const session = await activateAccountIntoSharedRuntime({
    account,
    logger,
    runtimeContract: contract,
    sharedCodexHome: contract.sharedCodexHome,
  });

  const activeAuth = await readFile(path.join(contract.sharedCodexHome, "auth.json"), "utf8");
  assert.match(activeAuth, /"work"/);

  await writeFile(
    path.join(contract.sharedCodexHome, "auth.json"),
    '{"tokens":{"account_id":"work"},"last_refresh":"refreshed"}\n',
    "utf8",
  );

  await syncSharedRuntimeBackToAccount({
    logger,
    session,
  });

  const syncedAuth = await readFile(
    path.join(runtimePaths.accountStateDirectory, "auth.json"),
    "utf8",
  );
  assert.match(syncedAuth, /"refreshed"/);

  await writeFile(
    path.join(contract.sharedCodexHome, "auth.json"),
    '{"tokens":{"account_id":"mutated"},"last_refresh":"mutated"}\n',
    "utf8",
  );
  await restoreSharedRuntimeFromBackup({
    account,
    backupRoot: session.backupRoot,
    logger,
    runtimeContract: contract,
    sharedCodexHome: contract.sharedCodexHome,
  });

  const restoredAuth = await readFile(path.join(contract.sharedCodexHome, "auth.json"), "utf8");
  assert.match(restoredAuth, /"shared"/);

  assertEvent(events, "account_activation.complete", "info");
  assertEvent(events, "account_sync.updated", "info");
  assertEvent(events, "account_activation.restore.complete", "warn");
});

test("account activation fails fast when stored auth is missing", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-activation-missing");
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  const contract = createRuntimeContract({
    accountRoot: path.join(tempRoot, "accounts"),
    credentialStoreMode: "file",
    logger,
    runtimeRoot: path.join(tempRoot, "runtime"),
    sharedCodexHome: path.join(tempRoot, "shared-home"),
  });

  const account: AccountRecord = {
    id: "acct-2",
    label: "missing",
    authDirectory: path.join(tempRoot, "accounts", "acct-2"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: null,
  };

  await assert.rejects(
    () =>
      activateAccountIntoSharedRuntime({
        account,
        logger,
        runtimeContract: contract,
        sharedCodexHome: contract.sharedCodexHome,
      }),
    /has no stored auth\.json/i,
  );

  assertEvent(events, "account_activation.missing_auth", "error");
});
