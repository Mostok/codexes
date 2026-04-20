import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { AccountRecord } from "../src/accounts/account-registry.js";
import {
  activateAccountIntoSharedRuntime,
  restoreSharedRuntimeFromBackup,
  syncExecutionWorkspaceBackToAccount,
  syncExecutionWorkspaceBackToSharedHome,
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

test("execution workspace sync merges same-account session directories without deleting sibling sessions", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-activation-merge");
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
    id: "acct-merge",
    label: "merge",
    authDirectory: path.join(tempRoot, "accounts", "acct-merge"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  const runtimePaths = resolveAccountRuntimePaths(contract, account.id);
  const firstCodexHome = path.join(tempRoot, "workspaces", "first", "codex-home");
  const secondCodexHome = path.join(tempRoot, "workspaces", "second", "codex-home");

  await mkdir(path.join(runtimePaths.accountStateDirectory, "sessions"), { recursive: true });
  await writeFile(
    path.join(runtimePaths.accountStateDirectory, "sessions", "before.json"),
    '{"session":"before"}\n',
    "utf8",
  );

  await mkdir(path.join(firstCodexHome, "sessions"), { recursive: true });
  await mkdir(path.join(secondCodexHome, "sessions"), { recursive: true });
  await writeFile(path.join(firstCodexHome, "auth.json"), '{"last_refresh":"first"}\n', "utf8");
  await writeFile(path.join(secondCodexHome, "auth.json"), '{"last_refresh":"second"}\n', "utf8");
  await writeFile(
    path.join(firstCodexHome, "sessions", "first.json"),
    '{"session":"first"}\n',
    "utf8",
  );
  await writeFile(
    path.join(secondCodexHome, "sessions", "second.json"),
    '{"session":"second"}\n',
    "utf8",
  );

  await syncExecutionWorkspaceBackToAccount({
    account,
    logger,
    runtimeContract: contract,
    workspace: {
      accountId: account.id,
      accountStateRoot: runtimePaths.accountStateDirectory,
      codexHome: firstCodexHome,
      executionRoot: contract.executionRoot,
      sessionId: "first",
      workspaceRoot: path.dirname(firstCodexHome),
    },
  });
  await syncExecutionWorkspaceBackToAccount({
    account,
    logger,
    runtimeContract: contract,
    workspace: {
      accountId: account.id,
      accountStateRoot: runtimePaths.accountStateDirectory,
      codexHome: secondCodexHome,
      executionRoot: contract.executionRoot,
      sessionId: "second",
      workspaceRoot: path.dirname(secondCodexHome),
    },
  });

  assert.match(
    await readFile(path.join(runtimePaths.accountStateDirectory, "sessions", "before.json"), "utf8"),
    /before/,
  );
  assert.match(
    await readFile(path.join(runtimePaths.accountStateDirectory, "sessions", "first.json"), "utf8"),
    /first/,
  );
  assert.match(
    await readFile(path.join(runtimePaths.accountStateDirectory, "sessions", "second.json"), "utf8"),
    /second/,
  );
  assert.match(
    await readFile(path.join(runtimePaths.accountStateDirectory, "auth.json"), "utf8"),
    /second/,
  );
  assertEvent(events, "account_sync.directory_merged", "info");
});

test("runtime path resolution rejects path traversal account ids", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-activation-path-safety");
  t.after(async () => removeTempDir(tempRoot));

  const { logger } = createTestLogger();
  const contract = createRuntimeContract({
    accountRoot: path.join(tempRoot, "accounts"),
    credentialStoreMode: "file",
    logger,
    runtimeRoot: path.join(tempRoot, "runtime"),
    sharedCodexHome: path.join(tempRoot, "shared-home"),
  });

  assert.throws(
    () => resolveAccountRuntimePaths(contract, "../outside"),
    /invalid account id/i,
  );
});

test("execution workspace sync persists shared artifacts back to shared home", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-activation-shared-sync");
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  const contract = createRuntimeContract({
    accountRoot: path.join(tempRoot, "accounts"),
    credentialStoreMode: "file",
    logger,
    runtimeRoot: path.join(tempRoot, "runtime"),
    sharedCodexHome: path.join(tempRoot, "shared-home"),
  });

  const workspaceCodexHome = path.join(tempRoot, "workspace", "codex-home");
  await mkdir(path.join(contract.sharedCodexHome, "trust"), { recursive: true });
  await writeFile(path.join(contract.sharedCodexHome, "mcp.json"), '{"version":"before"}\n', "utf8");
  await writeFile(path.join(contract.sharedCodexHome, "trust", "old.txt"), "before\n", "utf8");

  await mkdir(path.join(workspaceCodexHome, "trust"), { recursive: true });
  await writeFile(path.join(workspaceCodexHome, "mcp.json"), '{"version":"after"}\n', "utf8");
  await writeFile(path.join(workspaceCodexHome, "trust", "new.txt"), "after\n", "utf8");

  await syncExecutionWorkspaceBackToSharedHome({
    logger,
    runtimeContract: contract,
    sharedCodexHome: contract.sharedCodexHome,
    workspace: {
      accountId: "acct-shared",
      accountStateRoot: path.join(tempRoot, "accounts", "acct-shared", "state"),
      codexHome: workspaceCodexHome,
      executionRoot: contract.executionRoot,
      sessionId: "session-shared",
      workspaceRoot: path.dirname(workspaceCodexHome),
    },
  });

  assert.match(await readFile(path.join(contract.sharedCodexHome, "mcp.json"), "utf8"), /after/);
  assert.match(await readFile(path.join(contract.sharedCodexHome, "trust", "old.txt"), "utf8"), /before/);
  assert.match(await readFile(path.join(contract.sharedCodexHome, "trust", "new.txt"), "utf8"), /after/);
  assertEvent(events, "execution_workspace_shared_sync.complete", "info");
});
