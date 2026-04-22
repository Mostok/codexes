import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
import { prepareExecutionWorkspace } from "../src/runtime/login-workspace.js";
import { createRuntimeContract, resolveAccountRuntimePaths } from "../src/runtime/runtime-contract.js";
import {
  assertEvent,
  createTempDir,
  createTestLogger,
  removeTempDir,
} from "./test-helpers.js";

test("account activation swaps only runtime auth, syncs refreshed auth state, and restores backups", async (t) => {
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

  assert.match(await readFile(path.join(contract.sharedCodexHome, "auth.json"), "utf8"), /"work"/);
  assert.match(
    await readFile(path.join(contract.sharedCodexHome, "sessions", "active.json"), "utf8"),
    /shared/,
  );

  await writeFile(
    path.join(contract.sharedCodexHome, "auth.json"),
    '{"tokens":{"account_id":"work"},"last_refresh":"refreshed"}\n',
    "utf8",
  );

  await syncSharedRuntimeBackToAccount({
    logger,
    session,
  });

  assert.match(
    await readFile(path.join(runtimePaths.accountStateDirectory, "auth.json"), "utf8"),
    /"refreshed"/,
  );

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

  assert.match(await readFile(path.join(contract.sharedCodexHome, "auth.json"), "utf8"), /"shared"/);

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

test("prepareExecutionWorkspace reconciles direct auth and shared links inside stable account codex-home", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-linked-home");
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
    id: "acct-linked",
    label: "linked",
    authDirectory: path.join(tempRoot, "accounts", "acct-linked"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  const runtimePaths = resolveAccountRuntimePaths(contract, account.id);
  const staleFile = path.join(runtimePaths.accountStateDirectory, "codex-home", "stale.txt");

  await mkdir(path.join(contract.sharedCodexHome, "trust"), { recursive: true });
  await writeFile(path.join(contract.sharedCodexHome, "config.toml"), 'model = "gpt-5"\n', "utf8");
  await writeFile(path.join(contract.sharedCodexHome, "trust", "shared.txt"), "shared\n", "utf8");
  await mkdir(path.dirname(staleFile), { recursive: true });
  await writeFile(staleFile, "stale\n", "utf8");
  await mkdir(runtimePaths.accountStateDirectory, { recursive: true });
  await writeFile(
    path.join(runtimePaths.accountStateDirectory, "auth.json"),
    '{"last_refresh":"account-state"}\n',
    "utf8",
  );

  const workspace = await prepareExecutionWorkspace({
    account,
    logger,
    runtimeContract: contract,
    sharedCodexHome: contract.sharedCodexHome,
  });

  assert.equal(workspace.codexHome, path.join(runtimePaths.accountStateDirectory, "codex-home"));
  assert.equal(await stat(staleFile).catch(() => null), null);
  assert.match(await readFile(path.join(workspace.codexHome, "auth.json"), "utf8"), /account-state/);
  assert.match(await readFile(path.join(workspace.codexHome, "config.toml"), "utf8"), /gpt-5/);
  assert.match(await readFile(path.join(workspace.codexHome, "trust", "shared.txt"), "utf8"), /shared/);

  await writeFile(path.join(workspace.codexHome, "auth.json"), '{"last_refresh":"updated-via-link"}\n', "utf8");
  assert.match(
    await readFile(path.join(runtimePaths.accountStateDirectory, "auth.json"), "utf8"),
    /updated-via-link/,
  );

  await writeFile(path.join(workspace.codexHome, "sessions", "live.json"), '{"session":"live"}\n', "utf8");
  assert.match(await readFile(path.join(contract.sharedCodexHome, "sessions", "live.json"), "utf8"), /live/);

  assertEvent(events, "workspace_reconcile.auth_entry_ready", "info");
  assertEvent(events, "workspace_reconcile.complete", "info");
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

test("execution workspace sync helpers become no-ops in the direct-link model", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-direct-link-noop");
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
  const accountStateRoot = path.join(tempRoot, "accounts", "acct-noop", "state");
  await mkdir(path.join(workspaceCodexHome, "sessions"), { recursive: true });
  await mkdir(accountStateRoot, { recursive: true });
  await mkdir(contract.sharedCodexHome, { recursive: true });
  await writeFile(path.join(workspaceCodexHome, "auth.json"), '{"last_refresh":"workspace"}\n', "utf8");
  await writeFile(path.join(workspaceCodexHome, "sessions", "session.json"), '{"session":"workspace"}\n', "utf8");

  await syncExecutionWorkspaceBackToAccount({
    account: {
      id: "acct-noop",
      label: "noop",
      authDirectory: path.join(tempRoot, "accounts", "acct-noop"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
    },
    logger,
    runtimeContract: contract,
    workspace: {
      accountId: "acct-noop",
      accountStateRoot,
      codexHome: workspaceCodexHome,
      executionRoot: contract.executionRoot,
      sessionId: "noop",
      workspaceRoot: path.dirname(workspaceCodexHome),
    },
  });
  await syncExecutionWorkspaceBackToSharedHome({
    logger,
    runtimeContract: contract,
    sharedCodexHome: contract.sharedCodexHome,
    workspace: {
      accountId: "acct-noop",
      accountStateRoot,
      codexHome: workspaceCodexHome,
      executionRoot: contract.executionRoot,
      sessionId: "noop",
      workspaceRoot: path.dirname(workspaceCodexHome),
    },
  });

  assert.equal(await stat(path.join(accountStateRoot, "auth.json")).catch(() => null), null);
  assert.equal(await stat(path.join(contract.sharedCodexHome, "sessions", "session.json")).catch(() => null), null);
  assertEvent(events, "execution_workspace_sync.complete", "info");
  assertEvent(events, "execution_workspace_shared_sync.complete", "info");
});
