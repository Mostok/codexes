import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createAccountRegistry,
  type AccountRecord,
  type AccountRegistry,
} from "../src/accounts/account-registry.js";
import { resolveWrapperConfig } from "../src/config/wrapper-config.js";
import { selectAccountForExecution } from "../src/selection/select-account.js";
import type { ResolvedPaths } from "../src/core/paths.js";
import {
  assertEvent,
  createTempDir,
  createTestLogger,
  readJson,
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

function createFileRegistry(
  tempRoot: string,
  logger: ReturnType<typeof createTestLogger>["logger"],
): AccountRegistry {
  return createAccountRegistry({
    accountRoot: path.join(tempRoot, "accounts"),
    logger,
    registryFile: registryFilePath(tempRoot),
  });
}

function registryFilePath(tempRoot: string): string {
  return path.join(tempRoot, "data", "registry.json");
}

function buildStoredAccount(tempRoot: string, id: string, label: string): AccountRecord {
  const now = new Date().toISOString();
  return {
    id,
    label,
    authDirectory: path.join(tempRoot, "accounts", id),
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  };
}

async function writeRegistryDocument(
  tempRoot: string,
  accounts: AccountRecord[],
  defaultAccountId: string | null,
): Promise<void> {
  await mkdir(path.dirname(registryFilePath(tempRoot)), { recursive: true });
  await writeFile(
    registryFilePath(tempRoot),
    `${JSON.stringify({ schemaVersion: 1, defaultAccountId, accounts }, null, 2)}\n`,
    "utf8",
  );
}

async function readRegistryDocument(tempRoot: string): Promise<{
  defaultAccountId: string | null;
  accounts: AccountRecord[];
}> {
  return readJson(registryFilePath(tempRoot));
}

async function writeAuthState(
  account: AccountRecord,
  state: { accessToken: string; accountId: string },
): Promise<void> {
  const stateDirectory = path.join(account.authDirectory, "state");
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    path.join(stateDirectory, "auth.json"),
    JSON.stringify({
      access_token: state.accessToken,
      account_id: state.accountId,
    }),
    "utf8",
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
  });
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

test("manual-default selection blocks a free-plan default account", async (t) => {
  const tempRoot = await createTempDir("codexes-manual-default-free-plan");
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  const registry = createFileRegistry(tempRoot, logger);
  const account = await registry.addAccount({ label: "work" });
  await writeAuthState(account, {
    accessToken: "synthetic-access-token",
    accountId: "auth-account-1",
  });

  await assert.rejects(
    () =>
      selectAccountForExecution({
        fetchImpl: async () =>
          jsonResponse({
            active_until: "2026-05-15T00:00:00.000Z",
            plan_type: "FREE",
          }),
        logger,
        registry,
        strategy: "manual-default",
      }),
    /disabled by subscription expiration or plan/i,
  );
  assertEvent(events, "selection.manual_default_disabled", "debug");
  assert.equal(events.some((entry) => entry.event === "selection.manual_default"), false);
});

test("manual-default fallback does not mark a disabled single account as selected", async (t) => {
  const tempRoot = await createTempDir("codexes-manual-default-free-plan-fallback");
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  const registry = createFileRegistry(tempRoot, logger);
  const account = buildStoredAccount(tempRoot, "acct-1", "work");
  await writeRegistryDocument(tempRoot, [account], null);
  await writeAuthState(account, {
    accessToken: "synthetic-access-token",
    accountId: "auth-account-1",
  });

  await assert.rejects(
    () =>
      selectAccountForExecution({
        fetchImpl: async () =>
          jsonResponse({
            active_until: "2026-05-15T00:00:00.000Z",
            plan_type: "FREE",
          }),
        logger,
        registry,
        strategy: "manual-default",
      }),
    /disabled by subscription expiration or plan/i,
  );

  const registryDocument = await readRegistryDocument(tempRoot);
  assert.equal(registryDocument.defaultAccountId, null);
  assert.equal(registryDocument.accounts[0]?.lastUsedAt, null);
  assertEvent(events, "selection.manual_default_disabled", "debug");
  assert.equal(
    events.some((entry) => entry.event === "selection.manual_default_fallback_single"),
    false,
  );
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

test("single-account strategy blocks an expired paid account without mutating registry", async (t) => {
  const tempRoot = await createTempDir("codexes-single-account-expired");
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  const registry = createFileRegistry(tempRoot, logger);
  const account = buildStoredAccount(tempRoot, "acct-1", "solo");
  await writeRegistryDocument(tempRoot, [account], null);
  await writeAuthState(account, {
    accessToken: "synthetic-access-token",
    accountId: "auth-account-1",
  });

  await assert.rejects(
    () =>
      selectAccountForExecution({
        fetchImpl: async () =>
          jsonResponse({
            active_until: "2020-01-01T00:00:00.000Z",
            plan_type: "pro",
          }),
        logger,
        registry,
        strategy: "single-account",
      }),
    /disabled by subscription expiration or plan/i,
  );

  const registryDocument = await readRegistryDocument(tempRoot);
  assert.equal(registryDocument.defaultAccountId, null);
  assert.equal(registryDocument.accounts[0]?.lastUsedAt, null);
  assertEvent(events, "selection.single_account_disabled", "debug");
  assert.equal(events.some((entry) => entry.event === "selection.single_account"), false);
});

test("single-account strategy blocks a free-plan account without mutating registry", async (t) => {
  const tempRoot = await createTempDir("codexes-single-account-free-plan");
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  const registry = createFileRegistry(tempRoot, logger);
  const account = buildStoredAccount(tempRoot, "acct-1", "solo");
  await writeRegistryDocument(tempRoot, [account], null);
  await writeAuthState(account, {
    accessToken: "synthetic-access-token",
    accountId: "auth-account-1",
  });

  await assert.rejects(
    () =>
      selectAccountForExecution({
        fetchImpl: async () =>
          jsonResponse({
            active_until: "2026-05-15T00:00:00.000Z",
            plan_type: "free",
          }),
        logger,
        registry,
        strategy: "single-account",
      }),
    /disabled by subscription expiration or plan/i,
  );

  const registryDocument = await readRegistryDocument(tempRoot);
  assert.equal(registryDocument.defaultAccountId, null);
  assert.equal(registryDocument.accounts[0]?.lastUsedAt, null);
  assertEvent(events, "selection.single_account_disabled", "debug");
  assert.equal(events.some((entry) => entry.event === "selection.single_account"), false);
});

test("single-account strategy allows an unknown paid subscription plan", async (t) => {
  const tempRoot = await createTempDir("codexes-single-account-enterprise");
  t.after(async () => removeTempDir(tempRoot));

  const { logger } = createTestLogger();
  const registry = createFileRegistry(tempRoot, logger);
  const account = buildStoredAccount(tempRoot, "acct-1", "solo");
  await writeRegistryDocument(tempRoot, [account], null);
  await writeAuthState(account, {
    accessToken: "synthetic-access-token",
    accountId: "auth-account-1",
  });

  const result = await selectAccountForExecution({
    fetchImpl: async () =>
      jsonResponse({
        active_until: "2026-05-15T00:00:00.000Z",
        plan_type: "enterprise",
      }),
    logger,
    registry,
    strategy: "single-account",
  });

  assert.equal(result.id, account.id);
});

test("wrapper config defaults to experimental selection when no override is provided", async (t) => {
  const tempRoot = await createTempDir("codexes-wrapper-config-default"); 
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  const sharedCodexHome = path.join(tempRoot, "shared-home");
  await mkdir(sharedCodexHome, { recursive: true });
  await writeFile(
    path.join(sharedCodexHome, "config.toml"),
    'cli_auth_credentials_store = "file"\n',
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
    env: {},
    logger,
    paths,
  });

  assert.equal(config.credentialStoreMode, "file");
  assert.equal(config.accountSelectionStrategy, "remaining-limit");
  assert.equal(config.accountSelectionStrategySource, "default");
  assert.equal(config.experimentalSelection.enabled, true);
  assertEvent(events, "wrapper_config.selection_strategy_default_applied", "info");
  assertEvent(events, "wrapper_config.resolved", "info");
});

test("wrapper config resolves keyring mode and single-account strategy override", async (t) => {
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
  assert.equal(config.accountSelectionStrategySource, "env-override");
  assert.equal(config.selectionCacheFilePath, paths.selectionCacheFile);
  assert.equal(config.experimentalSelection.enabled, false);
  assert.equal(config.experimentalSelection.probeTimeoutMs, 3500);
  assert.equal(config.experimentalSelection.cacheTtlMs, 60000);
  assert.equal(config.experimentalSelection.useAccountIdHeader, false);
  assert.match(config.credentialStorePolicyReason, /only file-backed auth storage/i);
  assertEvent(events, "wrapper_config.selection_strategy_override_applied", "info");
  assertEvent(events, "wrapper_config.resolved", "info");
});

test("wrapper config falls back to remaining-limit on invalid strategy override", async (t) => {
  const tempRoot = await createTempDir("codexes-wrapper-config-invalid");
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  const sharedCodexHome = path.join(tempRoot, "shared-home");
  await mkdir(sharedCodexHome, { recursive: true });
  await writeFile(
    path.join(sharedCodexHome, "config.toml"),
    'cli_auth_credentials_store = "file"\n',
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
      CODEXES_ACCOUNT_SELECTION_STRATEGY: "not-a-real-mode",
    },
    logger,
    paths,
  });

  assert.equal(config.accountSelectionStrategy, "remaining-limit");
  assert.equal(config.accountSelectionStrategySource, "invalid-env-fallback");
  assert.equal(config.experimentalSelection.enabled, true);
  assertEvent(events, "wrapper_config.selection_strategy_invalid_override", "warn");
  assertEvent(events, "wrapper_config.resolved", "info");
});

test("wrapper config accepts remaining-limit-experimental as a legacy alias", async (t) => {
  const tempRoot = await createTempDir("codexes-wrapper-config-legacy-alias");
  t.after(async () => removeTempDir(tempRoot));

  const { logger } = createTestLogger();
  const sharedCodexHome = path.join(tempRoot, "shared-home");
  await mkdir(sharedCodexHome, { recursive: true });
  await writeFile(
    path.join(sharedCodexHome, "config.toml"),
    'cli_auth_credentials_store = "file"\n',
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
      CODEXES_ACCOUNT_SELECTION_STRATEGY: "remaining-limit-experimental",
    },
    logger,
    paths,
  });

  assert.equal(config.accountSelectionStrategy, "remaining-limit");
  assert.equal(config.accountSelectionStrategySource, "env-override");
  assert.equal(config.experimentalSelection.enabled, true);
});
