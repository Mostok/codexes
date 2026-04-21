import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createAccountRegistry,
  type AccountRecord,
  type AccountRegistry,
} from "../src/accounts/account-registry.js";
import { runRootCommand } from "../src/commands/root/run-root-command.js";
import type { ExperimentalSelectionConfig } from "../src/config/wrapper-config.js";
import type { AppContext } from "../src/core/context.js";
import { formatSelectionSummary } from "../src/selection/format-selection-summary.js";
import { selectAccountForExecution } from "../src/selection/select-account.js";
import { resolveSelectionSummary } from "../src/selection/selection-summary.js";
import {
  assertEvent,
  createCodexShim,
  createTempDir,
  createTestLogger,
  readJson,
  removeTempDir,
} from "./test-helpers.js";

const EXPERIMENTAL_SELECTION_CONFIG: ExperimentalSelectionConfig = {
  enabled: true,
  probeTimeoutMs: 500,
  cacheTtlMs: 60_000,
  useAccountIdHeader: true,
};

test("experimental selector ranks accounts by remaining percent windows and reuses cache", async (t) => {
  const tempRoot = await createTempDir("codexes-experimental-cache");
  t.after(async () => removeTempDir(tempRoot));

  const { accounts, cacheFilePath } = await createExperimentalAccounts(tempRoot);
  const fetchCalls: string[] = [];

  const firstRun = await selectAccountForExecution({
    experimentalSelection: EXPERIMENTAL_SELECTION_CONFIG,
    fetchImpl: async (url, init) => {
      if (isSubscriptionRequest(url)) {
        return subscriptionResponse(url);
      }

      const accountId = extractAccountIdHeader(init);
      fetchCalls.push(accountId ?? "missing");
      return jsonResponse(
        accountId === "acct-1"
          ? {
              rate_limit: {
                allowed: true,
                plan: "free",
                primary_window: { used_percent: 98 },
                secondary_window: { used_percent: 92 },
              },
            }
          : {
              rate_limit: {
                allowed: true,
                plan: "pro",
                primary_window: { used_percent: 95 },
                secondary_window: { used_percent: 94 },
              },
            },
      );
    },
    logger: createTestLogger().logger,
    registry: createRegistry(accounts, "acct-1"),
    selectionCacheFilePath: cacheFilePath,
    strategy: "remaining-limit",
  });

  assert.equal(firstRun.id, "acct-2");
  assert.deepEqual(fetchCalls.sort(), ["acct-1", "acct-2"]);

  const { events, logger } = createTestLogger();
  const secondRun = await selectAccountForExecution({
    experimentalSelection: EXPERIMENTAL_SELECTION_CONFIG,
    fetchImpl: async (url) => {
      if (isSubscriptionRequest(url)) {
        return subscriptionResponse(url);
      }

      throw new Error("usage cache should have been used");
    },
    logger,
    registry: createRegistry(accounts, "acct-1"),
    selectionCacheFilePath: cacheFilePath,
    strategy: "remaining-limit",
  });

  assert.equal(secondRun.id, "acct-2");
  assertEvent(events, "selection.usage_cache.hit", "debug");
  assertEvent(events, "selection.experimental_selected", "info");
});

test("experimental selector falls back when probe outcomes are mixed", async (t) => {
  const tempRoot = await createTempDir("codexes-experimental-mixed");
  t.after(async () => removeTempDir(tempRoot));

  const { accounts, cacheFilePath } = await createExperimentalAccounts(tempRoot);
  const { events, logger } = createTestLogger();

  const selected = await selectAccountForExecution({
    experimentalSelection: EXPERIMENTAL_SELECTION_CONFIG,
    fetchImpl: async (url, init) => {
      if (isSubscriptionRequest(url)) {
        return subscriptionResponse(url);
      }

      const accountId = extractAccountIdHeader(init);
      if (accountId === "acct-1") {
        return jsonResponse({
          rate_limit: {
            allowed: true,
            plan: "free",
            primary_window: { used_percent: 97 },
            secondary_window: { used_percent: 96 },
          },
        });
      }

      throw createNamedError("TimeoutError", "timed out");
    },
    logger,
    registry: createRegistry(accounts, "acct-1"),
    selectionCacheFilePath: cacheFilePath,
    strategy: "remaining-limit",
  });

  assert.equal(selected.id, "acct-1");
  assertEvent(events, "selection.experimental_fallback_mixed_probe_outcomes", "warn");
});

test("experimental selector falls back when all probes fail because auth is missing", async (t) => {
  const tempRoot = await createTempDir("codexes-experimental-auth-missing");
  t.after(async () => removeTempDir(tempRoot));

  const { accounts, cacheFilePath } = await createExperimentalAccounts(tempRoot, {
    omitAuthFor: ["acct-1", "acct-2"],
  });
  const { events, logger } = createTestLogger();

  const selected = await selectAccountForExecution({
    experimentalSelection: EXPERIMENTAL_SELECTION_CONFIG,
    fetchImpl: async () => jsonResponse({ allowed: true }),
    logger,
    registry: createRegistry(accounts, "acct-1"),
    selectionCacheFilePath: cacheFilePath,
    strategy: "remaining-limit",
  });

  assert.equal(selected.id, "acct-1");
  assertEvent(events, "selection.usage_probe.auth_missing", "warn");
  assertEvent(events, "selection.experimental_fallback_all_probes_failed", "warn");
});

test("experimental selector falls back when auth state is malformed", async (t) => {
  const tempRoot = await createTempDir("codexes-experimental-malformed-auth");
  t.after(async () => removeTempDir(tempRoot));

  const { accounts, cacheFilePath } = await createExperimentalAccounts(tempRoot, {
    malformedAuthFor: ["acct-1", "acct-2"],
  });
  const { events, logger } = createTestLogger();

  const selected = await selectAccountForExecution({
    experimentalSelection: EXPERIMENTAL_SELECTION_CONFIG,
    fetchImpl: async () => jsonResponse({ allowed: true }),
    logger,
    registry: createRegistry(accounts, "acct-1"),
    selectionCacheFilePath: cacheFilePath,
    strategy: "remaining-limit",
  });

  assert.equal(selected.id, "acct-1");
  assertEvent(events, "selection.account_auth_state.malformed_json", "warn");
  assertEvent(events, "selection.experimental_fallback_all_probes_failed", "warn");
});

test("experimental selector falls back when every account is exhausted", async (t) => {
  const tempRoot = await createTempDir("codexes-experimental-exhausted");
  t.after(async () => removeTempDir(tempRoot));

  const { accounts, cacheFilePath } = await createExperimentalAccounts(tempRoot);
  const { events, logger } = createTestLogger();

  const selected = await selectAccountForExecution({
    experimentalSelection: EXPERIMENTAL_SELECTION_CONFIG,
    fetchImpl: async (url) =>
      isSubscriptionRequest(url)
        ? subscriptionResponse(url)
        : jsonResponse({
        rate_limit: {
          allowed: true,
          plan: "free",
          limit_reached: true,
          primary_window: { used_percent: 100, limit_reached: true },
          secondary_window: { used_percent: 100, limit_reached: true },
        },
      }),
    logger,
    registry: createRegistry(accounts, "acct-1"),
    selectionCacheFilePath: cacheFilePath,
    strategy: "remaining-limit",
  });

  assert.equal(selected.id, "acct-1");
  assertEvent(events, "selection.experimental_fallback_all_accounts_exhausted", "warn");
});

test("experimental selector falls back on invalid response shapes and recovers from cache corruption", async (t) => {
  const tempRoot = await createTempDir("codexes-experimental-corrupt-cache");
  t.after(async () => removeTempDir(tempRoot));

  const { accounts, cacheFilePath } = await createExperimentalAccounts(tempRoot);
  await writeFile(cacheFilePath, "{ not-json", "utf8");
  const { events, logger } = createTestLogger();

  const selected = await selectAccountForExecution({
    experimentalSelection: EXPERIMENTAL_SELECTION_CONFIG,
    fetchImpl: async (url) =>
      isSubscriptionRequest(url)
        ? subscriptionResponse(url)
        : new Response(JSON.stringify("bad-shape"), { status: 200 }),
    logger,
    registry: createRegistry(accounts, "acct-1"),
    selectionCacheFilePath: cacheFilePath,
    strategy: "remaining-limit",
  });

  assert.equal(selected.id, "acct-1");
  assertEvent(events, "selection.usage_cache.corrupt", "warn");
  assertEvent(events, "selection.usage_probe.invalid_response", "warn");
  assertEvent(events, "selection.experimental_fallback_all_probes_failed", "warn");
});

test("experimental selector falls back with ambiguous usage only when remaining percent is unavailable", async (t) => {
  const tempRoot = await createTempDir("codexes-experimental-ambiguous-usage");
  t.after(async () => removeTempDir(tempRoot));

  const { accounts, cacheFilePath } = await createExperimentalAccounts(tempRoot);
  const { events, logger } = createTestLogger();

  const selected = await selectAccountForExecution({
    experimentalSelection: EXPERIMENTAL_SELECTION_CONFIG,
    fetchImpl: async (url) =>
      isSubscriptionRequest(url)
        ? subscriptionResponse(url)
        : jsonResponse({
        rate_limit: {
          allowed: true,
          primary_window: {
            reset_after_seconds: 300,
          },
          secondary_window: {
            reset_after_seconds: 600,
          },
        },
      }),
    logger,
    registry: createRegistry(accounts, "acct-1"),
    selectionCacheFilePath: cacheFilePath,
    strategy: "remaining-limit",
  });

  assert.equal(selected.id, "acct-1");
  assertEvent(events, "selection.experimental_fallback_ambiguous_usage", "warn");
});

test("experimental selector falls back on timeouts for every account", async (t) => {
  const tempRoot = await createTempDir("codexes-experimental-timeout");
  t.after(async () => removeTempDir(tempRoot));

  const { accounts, cacheFilePath } = await createExperimentalAccounts(tempRoot);
  const { events, logger } = createTestLogger();

  const selected = await selectAccountForExecution({
    experimentalSelection: EXPERIMENTAL_SELECTION_CONFIG,
    fetchImpl: async () => {
      throw createNamedError("TimeoutError", "timed out");
    },
    logger,
    registry: createRegistry(accounts, "acct-1"),
    selectionCacheFilePath: cacheFilePath,
        strategy: "remaining-limit",
  });

  assert.equal(selected.id, "acct-1");
  assertEvent(events, "selection.usage_probe.timeout", "warn");
  assertEvent(events, "selection.experimental_fallback_all_probes_failed", "warn");
});

test("experimental execution stays blocking when fallback cannot resolve a default account", async (t) => {
  const tempRoot = await createTempDir("codexes-experimental-no-default");
  t.after(async () => removeTempDir(tempRoot));

  const { accounts, cacheFilePath } = await createExperimentalAccounts(tempRoot);
  const { events, logger } = createTestLogger();

  await assert.rejects(
    () =>
      selectAccountForExecution({
        experimentalSelection: EXPERIMENTAL_SELECTION_CONFIG,
        fetchImpl: async (url, init) => {
          if (isSubscriptionRequest(url)) {
            return subscriptionResponse(url);
          }

          const accountId = extractAccountIdHeader(init);
          if (accountId === "acct-1") {
            return jsonResponse({
              rate_limit: {
                allowed: true,
                plan: "free",
                primary_window: { used_percent: 97 },
                secondary_window: { used_percent: 96 },
              },
            });
          }

          throw createNamedError("TimeoutError", "timed out");
        },
        logger,
        registry: createRegistry(accounts, null),
        selectionCacheFilePath: cacheFilePath,
        strategy: "remaining-limit",
      }),
    /no default account is selected/i,
  );

  assertEvent(events, "selection.experimental_fallback_mixed_probe_outcomes", "warn");
  assertEvent(events, "selection.execution_blocked_missing_default", "warn");
});

test("execution summary renderer stays compact and never uses the display table", async (t) => {
  const tempRoot = await createTempDir("codexes-execution-summary");
  t.after(async () => removeTempDir(tempRoot));

  const { accounts, cacheFilePath } = await createExperimentalAccounts(tempRoot);
  const { logger } = createTestLogger();

  const summary = await resolveSelectionSummary({
    experimentalSelection: EXPERIMENTAL_SELECTION_CONFIG,
    fetchImpl: async (url, init) => {
      if (isSubscriptionRequest(url)) {
        return subscriptionResponse(url);
      }

      const accountId = extractAccountIdHeader(init);
      return jsonResponse(
        accountId === "acct-1"
          ? {
              rate_limit: {
                allowed: true,
                plan: "free",
                primary_window: { used_percent: 98 },
                secondary_window: { used_percent: 92 },
              },
            }
          : {
              rate_limit: {
                allowed: true,
                plan: "pro",
                primary_window: { used_percent: 95 },
                secondary_window: { used_percent: 93 },
              },
            },
      );
    },
    logger,
    mode: "execution",
    registry: createRegistry(accounts, "acct-1"),
    selectionCacheFilePath: cacheFilePath,
    strategy: "remaining-limit",
  });

  const rendered = formatSelectionSummary({
    capabilities: {
      stdoutIsTTY: false,
      useColor: false,
    },
    logger,
    renderVariant: "execution-summary",
    summary,
  });

  assert.match(rendered, /personal \(acct-2\) \[selected, rank #1\] expiredAt=15\.05\.2026 status=usable 5h=5% weekly=7% plan=pro source=fresh detail=rankable/);
  assert.match(rendered, /Selected account: personal \(acct-2\) via remaining-limit\./);
  assert.doesNotMatch(rendered, /\| Label +\| Account ID +\|/);
});

test("runRootCommand launches the experimentally selected account", async (t) => {
  const tempRoot = await createTempDir("codexes-root-experimental");
  t.after(async () => removeTempDir(tempRoot));

  const dataRoot = path.join(tempRoot, "data");
  const accountRoot = path.join(dataRoot, "accounts");
  const sharedCodexHome = path.join(dataRoot, "shared-home");
  const runtimeRoot = path.join(dataRoot, "runtime");
  const registryFile = path.join(dataRoot, "registry.json");
  const cacheFilePath = path.join(dataRoot, "selection-cache.json");
  const outputFile = path.join(tempRoot, "child-output.json");
  const fakeCodexScript = path.join(tempRoot, "fake-codex.mjs");
  const binRoot = path.join(tempRoot, "bin");

  await mkdir(sharedCodexHome, { recursive: true });
  await mkdir(accountRoot, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(path.join(sharedCodexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', "utf8");
  await writeFile(
    fakeCodexScript,
    [
      "import { readFile, writeFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      "const authFile = path.join(process.env.CODEX_HOME, 'auth.json');",
      "const auth = JSON.parse(await readFile(authFile, 'utf8'));",
      "auth.last_refresh = 'updated-by-child';",
      "await writeFile(authFile, JSON.stringify(auth, null, 2));",
      "await writeFile(process.env.TEST_OUTPUT_FILE, JSON.stringify({ accountId: auth.tokens.account_id }, null, 2));",
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf8",
  );
  const codexBinaryPath = await createCodexShim({ binRoot, scriptPath: fakeCodexScript });

  const registryLogger = createTestLogger().logger;
  const registry = createAccountRegistry({
    accountRoot,
    logger: registryLogger,
    registryFile,
  });
  const work = await registry.addAccount({ label: "work" });
  const personal = await registry.addAccount({ label: "personal" });
  await writeAccountState(work, {
    accessToken: "token-work",
    accountId: "acct-1",
  });
  await writeAccountState(personal, {
    accessToken: "token-personal",
    accountId: "acct-2",
  });

  const events: Array<{
    details: Record<string, unknown> | undefined;
    event: string;
    level: "debug" | "info" | "warn" | "error";
  }> = [];
  const stdoutChunks: string[] = [];
  const context = createRootCommandContext({
    argv: ["chat"],
    cacheFilePath,
    codexBinaryPath,
    dataRoot,
    events,
    outputFile,
    registryFile,
    runtimeRoot,
    sharedCodexHome,
    stdoutChunks,
  });

  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (isSubscriptionRequest(url)) {
      return subscriptionResponse(url);
    }

    const accountId = extractAccountIdHeader(init);
    return jsonResponse(
      accountId === "acct-1"
        ? {
            rate_limit: {
              allowed: true,
              plan: "free",
              primary_window: { used_percent: 99 },
              secondary_window: { used_percent: 91 },
            },
          }
        : {
            rate_limit: {
              allowed: true,
              plan: "pro",
              primary_window: { used_percent: 96 },
              secondary_window: { used_percent: 93 },
            },
          },
    );
  });
  const previousOutputFile = process.env.TEST_OUTPUT_FILE;
  process.env.TEST_OUTPUT_FILE = outputFile;
  t.after(() => {
    if (typeof previousOutputFile === "string") {
      process.env.TEST_OUTPUT_FILE = previousOutputFile;
      return;
    }

    delete process.env.TEST_OUTPUT_FILE;
  });

  const exitCode = await runRootCommand(context);
  assert.equal(exitCode, 0);

  const childOutput = await readJson<{ accountId: string }>(outputFile);
  assert.equal(childOutput.accountId, "acct-2");
  assert.match(
    stdoutChunks.join(""),
    /Account selection summary:[\s\S]*Selected account: personal \(([^)]+)\) via remaining-limit\./,
  );
  assert.match(stdoutChunks.join(""), /\| \+ +\| +1 +\| personal +\| .* \| 15\.05\.2026 +\| usable +\| 4% +\| +7% +\| pro +\| fresh +\|/);
  assert.match(stdoutChunks.join(""), /\| Sel +\| +Ranking +\| Label +\| Account id +\| Expired at +\| Status +\|/);

  const syncedAuth = JSON.parse(
    await readFile(path.join(personal.authDirectory, "state", "auth.json"), "utf8"),
  ) as { last_refresh: string };
  assert.equal(syncedAuth.last_refresh, "updated-by-child");
  assertEvent(events, "root.selection.strategy_active", "info");
  assertEvent(events, "root.selection.experimental_enabled", "info");
  assertEvent(events, "root.selection.experimental_selected", "info");
  assert.equal(
    findLoggedEvent(events, "root.summary_rendered", "info")?.details?.renderVariant,
    "display-table",
  );
});

function createRegistry(
  accounts: AccountRecord[],
  defaultAccountId: string | null,
): AccountRegistry {
  return {
    async addAccount() {
      throw new Error("not implemented");
    },
    async getDefaultAccount() {
      return accounts.find((account) => account.id === defaultAccountId) ?? null;
    },
    async listAccounts() {
      return accounts;
    },
    async removeAccount() {
      throw new Error("not implemented");
    },
    async selectAccount(accountId) {
      const account = accounts.find((entry) => entry.id === accountId);
      if (!account) {
        throw new Error(`Unknown account ${accountId}`);
      }

      return account;
    },
  };
}

async function createExperimentalAccounts(
  tempRoot: string,
  options?: {
    malformedAuthFor?: string[];
    omitAuthFor?: string[];
  },
): Promise<{ accounts: AccountRecord[]; cacheFilePath: string }> {
  const cacheFilePath = path.join(tempRoot, "selection-cache.json");
  const accounts = [
    buildAccount(tempRoot, "acct-1", "work"),
    buildAccount(tempRoot, "acct-2", "personal"),
  ];

  for (const account of accounts) {
    if (options?.omitAuthFor?.includes(account.id)) {
      continue;
    }

    if (options?.malformedAuthFor?.includes(account.id)) {
      await mkdir(path.join(account.authDirectory, "state"), { recursive: true });
      await writeFile(path.join(account.authDirectory, "state", "auth.json"), "{", "utf8");
      continue;
    }

    await writeAccountState(account, {
      accessToken: `token-${account.id}`,
      accountId: account.id,
    });
  }

  return { accounts, cacheFilePath };
}

function buildAccount(root: string, id: string, label: string): AccountRecord {
  const now = new Date().toISOString();
  return {
    id,
    label,
    authDirectory: path.join(root, id),
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  };
}

async function writeAccountState(
  account: AccountRecord,
  input: { accessToken: string; accountId: string },
): Promise<void> {
  await mkdir(path.join(account.authDirectory, "state"), { recursive: true });
  await writeFile(
    path.join(account.authDirectory, "state", "auth.json"),
    `${JSON.stringify(
      {
        auth_mode: "chatgpt",
        last_refresh: "2026-04-13T00:00:00.000Z",
        tokens: {
          access_token: input.accessToken,
          account_id: input.accountId,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function createRootCommandContext(input: {
  argv: string[];
  cacheFilePath: string;
  codexBinaryPath: string;
  dataRoot: string;
  events: Array<{
    details: Record<string, unknown> | undefined;
    event: string;
    level: "debug" | "info" | "warn" | "error";
  }>;
  outputFile: string;
  registryFile: string;
  runtimeRoot: string;
  sharedCodexHome: string;
  stdoutChunks?: string[];
}): AppContext {
  const stdout = {
    isTTY: false,
    write(chunk: string | Uint8Array) {
      input.stdoutChunks?.push(String(chunk));
      return true;
    },
  } as NodeJS.WriteStream;

  return {
    argv: input.argv,
    executablePath: process.execPath,
    environment: {
      cwd: process.cwd(),
      platform: process.platform,
      runtime: process.version,
    },
    io: {
      stdout,
      stderr: { write() { return true; } } as NodeJS.WriteStream,
    },
    output: {
      stdoutIsTTY: stdout.isTTY === true,
    },
    logging: {
      level: "DEBUG",
      sink: {
        write(level, event, details) {
          input.events.push({
            level: level.toLowerCase() as "debug" | "info" | "warn" | "error",
            event,
            details,
          });
        },
      },
    },
    paths: {
      projectRoot: process.cwd(),
      dataRoot: input.dataRoot,
      sharedCodexHome: input.sharedCodexHome,
      accountRoot: path.join(input.dataRoot, "accounts"),
      runtimeRoot: input.runtimeRoot,
      executionRoot: path.join(input.runtimeRoot, "executions"),
      registryFile: input.registryFile,
      wrapperConfigFile: path.join(input.dataRoot, "codexes.json"),
      codexConfigFile: path.join(input.sharedCodexHome, "config.toml"),
      selectionCacheFile: input.cacheFilePath,
    },
    runtimeInitialization: {
      firstRun: false,
      legacyCodexHome: path.join(input.dataRoot, "legacy"),
      sharedCodexHome: input.sharedCodexHome,
      createdDirectories: [],
      createdFiles: [],
      copiedSharedArtifacts: [],
      skippedArtifacts: [],
    },
    wrapperConfig: {
      configFilePath: path.join(input.dataRoot, "codexes.json"),
      codexConfigFilePath: path.join(input.sharedCodexHome, "config.toml"),
      selectionCacheFilePath: input.cacheFilePath,
      credentialStoreMode: "file",
      credentialStorePolicyReason: "file mode detected in Codex config",
      accountSelectionStrategy: "remaining-limit",
      accountSelectionStrategySource: "default",
      runtimeModel: "isolated-execution",
      runtimeModelSource: "default",
      experimentalSelection: EXPERIMENTAL_SELECTION_CONFIG,
    },
    codexBinary: {
      path: input.codexBinaryPath,
      candidates: [input.codexBinaryPath],
      rejectedCandidates: [],
    },
  };
}

function extractAccountIdHeader(init: RequestInit | undefined): string | null {
  if (!init?.headers) {
    return null;
  }

  const headers = new Headers(init.headers);
  return headers.get("OpenAI-Account-ID");
}

function isSubscriptionRequest(url: string | URL | Request): boolean {
  return String(url).startsWith("https://chatgpt.com/backend-api/subscriptions");
}

function subscriptionResponse(url: string | URL | Request): Response {
  const accountId = new URL(String(url)).searchParams.get("account_id");
  return jsonResponse({
    active_until:
      accountId === "acct-1"
        ? "2026-05-04T00:00:00.000Z"
        : "2026-05-15T00:00:00.000Z",
  });
}

function findLoggedEvent(
  events: Array<{
    details: Record<string, unknown> | undefined;
    event: string;
    level: "debug" | "info" | "warn" | "error";
  }>,
  event: string,
  level?: "debug" | "info" | "warn" | "error",
): {
  details: Record<string, unknown> | undefined;
  event: string;
  level: "debug" | "info" | "warn" | "error";
} | undefined {
  return events.find((entry) => entry.event === event && (!level || entry.level === level));
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createNamedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
