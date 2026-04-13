import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { AccountRecord, AccountRegistry } from "../src/accounts/account-registry.js";
import { resolveWrapperConfig } from "../src/config/wrapper-config.js";
import { selectAccountForExecution } from "../src/selection/select-account.js";
import type { ResolvedPaths } from "../src/core/paths.js";
import {
  assertEvent,
  createTempDir,
  createTestLogger,
  removeTempDir,
} from "./test-helpers.js";

function buildAccount(id: string, label: string): AccountRecord {
  const now = new Date().toISOString();
  return {
    id,
    label,
    authDirectory: `${id}-dir`,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  };
}

function unsupportedRegistry(accounts: AccountRecord[], selected: string[] = []): AccountRegistry {
  return {
    async addAccount() {
      throw new Error("not implemented");
    },
    async getDefaultAccount() {
      return null;
    },
    async listAccounts() {
      return accounts;
    },
    async removeAccount() {
      throw new Error("not implemented");
    },
    async selectAccount(accountId) {
      selected.push(accountId);
      return accounts[0]!;
    },
  };
}

test("manual-default selection auto-selects the only configured account", async () => {
  const selected: string[] = [];
  const account = buildAccount("acct-1", "work");
  const { events, logger } = createTestLogger();

  const result = await selectAccountForExecution({
    logger,
    registry: unsupportedRegistry([account], selected),
    strategy: "manual-default",
  });

  assert.equal(result.id, account.id);
  assert.deepEqual(selected, [account.id]);
  assertEvent(events, "selection.manual_default_fallback_single", "info");
});

test("single-account strategy rejects unsupported states", async () => {
  const accounts = [buildAccount("acct-1", "work"), buildAccount("acct-2", "personal")];
  const { logger } = createTestLogger();

  await assert.rejects(
    () =>
      selectAccountForExecution({
        logger,
        registry: unsupportedRegistry(accounts),
        strategy: "single-account",
      }),
    /requires exactly one configured account/i,
  );
});

test("wrapper config resolves keyring mode and single-account strategy", async (t) => {
  const tempRoot = await createTempDir("codexes-wrapper-config");
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  const sharedCodexHome = path.join(tempRoot, "shared-home");
  await mkdir(sharedCodexHome, { recursive: true });
  await writeFile(
    path.join(sharedCodexHome, "config.toml"),
    'cli_auth_credentials_store = "keyring"\n',
    "utf8",
  );

  const paths: ResolvedPaths = {
    projectRoot: tempRoot,
    dataRoot: tempRoot,
    sharedCodexHome,
    accountRoot: path.join(tempRoot, "accounts"),
    runtimeRoot: path.join(tempRoot, "runtime"),
    registryFile: path.join(tempRoot, "registry.json"),
    wrapperConfigFile: path.join(tempRoot, "codexes.json"),
    codexConfigFile: path.join(sharedCodexHome, "config.toml"),
    selectionCacheFile: path.join(tempRoot, "selection-cache.json"),
  };

  const config = await resolveWrapperConfig({
    env: {
      CODEXES_ACCOUNT_SELECTION_STRATEGY: "single-account",
    },
    logger,
    paths,
  });

  assert.equal(config.credentialStoreMode, "keyring");
  assert.equal(config.accountSelectionStrategy, "single-account");
  assert.equal(config.selectionCacheFilePath, paths.selectionCacheFile);
  assert.equal(config.experimentalSelection.enabled, false);
  assert.equal(config.experimentalSelection.probeTimeoutMs, 3500);
  assert.equal(config.experimentalSelection.cacheTtlMs, 60000);
  assert.equal(config.experimentalSelection.useAccountIdHeader, false);
  assert.match(config.credentialStorePolicyReason, /only file-backed auth storage/i);
  assertEvent(events, "wrapper_config.resolved", "info");
});
