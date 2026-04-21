import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createAccountRegistry, type AccountRecord, type AccountRegistry } from "../src/accounts/account-registry.js";
import { runAccountListCommand } from "../src/commands/account-list/run-account-list-command.js";
import type { AppContext } from "../src/core/context.js";
import { formatSelectionSummary } from "../src/selection/format-selection-summary.js";
import { resolveSelectionSummary } from "../src/selection/selection-summary.js";
import type { LoggedEvent } from "./test-helpers.js";
import {
  assertEvent,
  createTempDir,
  createTestLogger,
  removeTempDir,
} from "./test-helpers.js";

test("account list renders english limit summaries and reuses cached probe data", async (t) => {
  const tempRoot = await createTempDir("codexes-account-list-cache");
  t.after(async () => removeTempDir(tempRoot));

  const setup = await createAccountListFixture(tempRoot);
  const firstOutput: string[] = [];

  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (isSubscriptionRequest(url)) {
      return subscriptionResponseForAccount(setup, url);
    }

    const accountId = extractAccountIdHeader(init);
    return jsonResponse(
      accountId === setup.work.id
        ? {
            rate_limit: {
              allowed: true,
              plan: "free",
              primary_window: { used_percent: 98 },
              secondary_window: { used_percent: 91 },
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
  });

  const firstContext = createAccountListContext({
    cacheFilePath: setup.cacheFilePath,
    events: setup.events,
    outputChunks: firstOutput,
    registryFile: setup.registryFile,
    sharedCodexHome: setup.sharedCodexHome,
    tempRoot,
  });

  assert.equal(await runAccountListCommand(firstContext), 0);
  assert.match(firstOutput.join(""), /Account selection summary:/);
  assert.match(firstOutput.join(""), /\| Sel +\| +Ranking +\| Label +\| Account id +\| Expired at +\| Status +\| +5h +\| +Weekly +\| Plan +\| Source +\|/);
  assert.match(firstOutput.join(""), /\| \+ +\| +1 +\| personal +\| .* \| 15\.05\.2026 +\| usable +\| +5% +\| +7% +\| pro +\| fresh +\|/);
  assert.match(firstOutput.join(""), /Selected account: personal/);
  assert.doesNotMatch(firstOutput.join(""), /\u001b\[/);

  const secondOutput: string[] = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    if (isSubscriptionRequest(url)) {
      return subscriptionResponseForAccount(setup, url);
    }

    throw new Error("usage cache should satisfy account list");
  });

  const secondContext = createAccountListContext({
    cacheFilePath: setup.cacheFilePath,
    events: setup.events,
    outputChunks: secondOutput,
    registryFile: setup.registryFile,
    sharedCodexHome: setup.sharedCodexHome,
    tempRoot,
  });

  assert.equal(await runAccountListCommand(secondContext), 0);
  assert.match(secondOutput.join(""), /\| cache +\|/);
  assertEvent(setup.events, "account_list.summary_rendered", "info");
  assert.equal(
    findEvent(setup.events, "account_list.summary_rendered", "info")?.details?.renderVariant,
    "display-table",
  );
  assert.equal(
    findEvent(setup.events, "account_list.selection.format_summary.start", "debug")?.details?.renderVariant,
    "display-table",
  );
  assert.equal(
    findEvent(setup.events, "account_list.selection.render_table.complete", "debug")?.details?.renderStyle,
    "plain",
  );
});

test("selection formatter adds ANSI color only for TTY-capable output", async (t) => {
  const tempRoot = await createTempDir("codexes-account-list-tty");
  t.after(async () => removeTempDir(tempRoot));

  const setup = await createAccountListFixture(tempRoot);
  const { logger } = createTestLogger();

  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (isSubscriptionRequest(url)) {
      return subscriptionResponseForAccount(setup, url);
    }

    const accountId = extractAccountIdHeader(init);
    return jsonResponse(
      accountId === setup.work.id
        ? { rate_limit: { plan: "free", primary_window: { used_percent: 70 }, secondary_window: { used_percent: 20 } } }
        : { rate_limit: { plan: "pro", primary_window: { used_percent: 15 }, secondary_window: { used_percent: 10 } } },
    );
  });

  const summary = await resolveSelectionSummary({
    experimentalSelection: {
      enabled: true,
      probeTimeoutMs: 500,
      cacheTtlMs: 60_000,
      useAccountIdHeader: true,
    },
    fetchImpl: fetch,
    logger,
    mode: "display-only",
    registry: createStubRegistry([setup.work, setup.personal]),
    selectionCacheFilePath: setup.cacheFilePath,
    strategy: "remaining-limit",
  });

  const plainRendered = formatSelectionSummary({
    capabilities: {
      stdoutIsTTY: false,
      useColor: false,
    },
    logger,
    renderVariant: "display-table",
    summary,
  });
  const colorRendered = formatSelectionSummary({
    capabilities: {
      stdoutIsTTY: true,
      useColor: true,
    },
    logger,
    renderVariant: "display-table",
    summary,
  });

  assert.doesNotMatch(plainRendered, /\u001b\[/);
  assert.match(colorRendered, /\u001b\[/);
  assert.match(colorRendered, /\| Sel +\| +Ranking +\| Label +\| Account id +\| Expired at +\| Status +\| +5h +\| +Weekly +\| Plan +\| Source +\|/);
  assert.match(colorRendered, /\| \+ +\| +1 +\| personal +\| .* \| \u001b\[32m15\.05\.2026\u001b\[0m +\| \u001b\[32musable\u001b\[0m +\|/);
  assert.match(colorRendered, /\u001b\[33m30%/);
  assert.match(colorRendered, /\u001b\[32m85%/);
  assert.match(colorRendered, /\u001b\[1;95mpro\u001b\[0m/);
});

test("selection formatter renders expiration values and invalid metadata safely", async () => {
  const { logger } = createTestLogger();

  const rendered = formatSelectionSummary({
    capabilities: {
      stdoutIsTTY: false,
      useColor: false,
    },
    logger,
    now: new Date("2026-04-18T00:00:00.000Z"),
    renderVariant: "display-table",
    summary: {
      entries: [
        {
          account: {
            authDirectory: "/tmp/acct-1",
            createdAt: "2026-04-01T00:00:00.000Z",
            id: "acct-1",
            label: "missing-date",
            lastUsedAt: null,
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
          failureCategory: null,
          failureMessage: null,
          isDefault: false,
          isEligibleForRanking: false,
          isSelected: false,
          rankingPosition: null,
          snapshot: null,
          source: "unavailable",
          expiredAt: { displayValue: null, isoValue: null, source: "missing" },
          paidAt: { displayValue: null, isoValue: null, source: "missing" },
        },
        {
          account: {
            authDirectory: "/tmp/acct-2",
            createdAt: "2026-04-01T00:00:00.000Z",
            id: "acct-2",
            label: "bad-date",
            lastUsedAt: null,
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
          failureCategory: null,
          failureMessage: null,
          isDefault: false,
          isEligibleForRanking: false,
          isSelected: false,
          rankingPosition: null,
          snapshot: null,
          source: "unavailable",
          expiredAt: {
            displayValue: "20.04.2026",
            isoValue: "not-a-date",
            source: "active_until",
          },
          paidAt: {
            displayValue: "20.04.2026",
            isoValue: "not-a-date",
            source: "metadata.subscriptionPaidAt",
          },
        },
        {
          account: {
            authDirectory: "/tmp/acct-3",
            createdAt: "2026-04-01T00:00:00.000Z",
            id: "acct-3",
            label: "legacy",
            lastUsedAt: null,
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
          paidAt: {
            displayValue: "20.04.2026",
            isoValue: "2026-04-20T00:00:00.000Z",
            source: "metadata.subscriptionAcquiredAt",
          },
          expiredAt: {
            displayValue: "20.04.2026",
            isoValue: "2026-04-20T00:00:00.000Z",
            source: "active_until",
          },
          failureCategory: null,
          failureMessage: null,
          isDefault: false,
          isEligibleForRanking: false,
          isSelected: false,
          rankingPosition: null,
          snapshot: null,
          source: "unavailable",
        },
      ],
      executionBlockedReason: null,
      fallbackReason: null,
      mode: "display-only",
      selectedAccount: null,
      selectedBy: null,
      strategy: "manual-default",
    },
  });

  assert.match(rendered, /\| +\| +\| missing-date +\| acct-1 +\| - +\| not-probed +\|/);
  assert.match(rendered, /\| +\| +\| bad-date +\| acct-2 +\| - +\| not-probed +\|/);
  assert.match(rendered, /\| +\| +\| legacy +\| acct-3 +\| 20\.04\.2026 +\| not-probed +\|/);
});

test("display-only selection keeps usage ranking when subscription expiration fails", async (t) => {
  const tempRoot = await createTempDir("codexes-account-list-subscription-failure");
  t.after(async () => removeTempDir(tempRoot));

  const setup = await createAccountListFixture(tempRoot);
  const { events, logger } = createTestLogger();

  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (isSubscriptionRequest(url)) {
      return new Response("blocked", { status: 403 });
    }

    const accountId = extractAccountIdHeader(init);
    return jsonResponse(
      accountId === setup.work.id
        ? {
            rate_limit: {
              allowed: true,
              plan: "free",
              primary_window: { used_percent: 99 },
              secondary_window: { used_percent: 94 },
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
  });

  const summary = await resolveSelectionSummary({
    experimentalSelection: {
      enabled: true,
      probeTimeoutMs: 500,
      cacheTtlMs: 60_000,
      useAccountIdHeader: true,
    },
    fetchImpl: fetch,
    logger,
    mode: "display-only",
    registry: createStubRegistry([setup.work, setup.personal]),
    selectionCacheFilePath: setup.cacheFilePath,
    strategy: "remaining-limit",
  });
  const rendered = formatSelectionSummary({
    capabilities: {
      stdoutIsTTY: false,
      useColor: false,
    },
    logger,
    renderVariant: "display-table",
    summary,
  });

  assert.equal(summary.selectedAccount?.id, setup.personal.id);
  assert.equal(summary.entries.find((entry) => entry.account.id === setup.personal.id)?.rankingPosition, 1);
  assert.equal(summary.entries.find((entry) => entry.account.id === setup.work.id)?.rankingPosition, 2);
  assert.match(rendered, /\| \+ +\| +1 +\| personal +\| .* \| - +\| usable +\| +5% +\| +7% +\| pro +\| fresh +\|/);
  assert.match(rendered, /\| +\| +2 +\| work +\| .* \| - +\| usable +\| +1% +\| +6% +\| free +\| fresh +\|/);
  assertEvent(events, "selection.subscription_expiration.http_error", "debug");
  assert.equal(findEvent(events, "selection.experimental_fallback_mixed_probe_outcomes", "warn"), undefined);
  assert.equal(findEvent(events, "selection.experimental_fallback_all_probes_failed", "warn"), undefined);
});

test("display-only selection summary explains mixed probe fallback without an execution winner", async (t) => {
  const tempRoot = await createTempDir("codexes-account-list-fallback");
  t.after(async () => removeTempDir(tempRoot));

  const setup = await createAccountListFixture(tempRoot);
  const { events, logger } = createTestLogger();

  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (isSubscriptionRequest(url)) {
      return subscriptionResponseForAccount(setup, url);
    }

    const accountId = extractAccountIdHeader(init);
    if (accountId === setup.work.id) {
      return jsonResponse({
        rate_limit: {
          allowed: true,
          plan: "free",
          primary_window: { used_percent: 97 },
          secondary_window: { used_percent: 92 },
        },
      });
    }

      throw createNamedError("TimeoutError", "timed out");
  });

  const summary = await resolveSelectionSummary({
    experimentalSelection: {
      enabled: true,
      probeTimeoutMs: 500,
      cacheTtlMs: 60_000,
      useAccountIdHeader: true,
    },
    fetchImpl: fetch,
    logger,
    mode: "display-only",
    registry: createStubRegistry([setup.work, setup.personal]),
    selectionCacheFilePath: setup.cacheFilePath,
    strategy: "remaining-limit",
  });
  const rendered = formatSelectionSummary({
    capabilities: {
      stdoutIsTTY: false,
      useColor: false,
    },
    logger,
    renderVariant: "display-table",
    summary,
  });
  assert.match(
    rendered,
    /Fallback: some account probes failed, so codexes could not establish a reliable execution winner\./,
  );
  assert.match(rendered, /Selected account: unavailable for execution\./);
  assert.match(rendered, /Execution note: Multiple accounts are configured but no default account is selected\./);
  assert.match(rendered, /\| +\| +\| work +\| .* \| 04\.05\.2026 +\| usable +\| +3% +\| +8% +\| free +\| fresh +\|/);
  assert.match(rendered, /\| +\| +\| personal +\| .* \| 15\.05\.2026 +\| probe-failed +\| +unknown +\| +unknown +\| - +\| fresh +\|/);
  assertEvent(events, "selection.display_only_missing_execution_account", "info");
});

test("display-only selection summary explains all-probes-failed fallback without an execution winner", async (t) => {
  const tempRoot = await createTempDir("codexes-account-list-all-failed");
  t.after(async () => removeTempDir(tempRoot));

  const setup = await createAccountListFixture(tempRoot);
  const { events, logger } = createTestLogger();

  t.mock.method(globalThis, "fetch", async () => {
    throw createNamedError("TimeoutError", "timed out");
  });

  const summary = await resolveSelectionSummary({
    experimentalSelection: {
      enabled: true,
      probeTimeoutMs: 500,
      cacheTtlMs: 60_000,
      useAccountIdHeader: true,
    },
    fetchImpl: fetch,
    logger,
    mode: "display-only",
    registry: createStubRegistry([setup.work, setup.personal]),
    selectionCacheFilePath: setup.cacheFilePath,
    strategy: "remaining-limit",
  });
  const rendered = formatSelectionSummary({
    capabilities: {
      stdoutIsTTY: false,
      useColor: false,
    },
    logger,
    renderVariant: "display-table",
    summary,
  });
  assert.match(
    rendered,
    /Fallback: every account probe failed, so codexes could not establish a reliable execution winner\./,
  );
  assert.match(rendered, /Selected account: unavailable for execution\./);
  assert.match(rendered, /\| +\| +\| work +\| .* \| - +\| probe-failed +\| +unknown +\| +unknown +\| - +\| fresh +\|/);
  assert.match(rendered, /\| +\| +\| personal +\| .* \| - +\| probe-failed +\| +unknown +\| +unknown +\| - +\| fresh +\|/);
  assertEvent(events, "selection.display_only_missing_execution_account", "info");
});

async function createAccountListFixture(tempRoot: string): Promise<{
  cacheFilePath: string;
  events: LoggedEvent[];
  personal: AccountRecord;
  registryFile: string;
  sharedCodexHome: string;
  work: AccountRecord;
}> {
  const dataRoot = path.join(tempRoot, "data");
  const accountRoot = path.join(dataRoot, "accounts");
  const sharedCodexHome = path.join(dataRoot, "shared-home");
  const runtimeRoot = path.join(dataRoot, "runtime");
  const registryFile = path.join(dataRoot, "registry.json");
  const cacheFilePath = path.join(dataRoot, "selection-cache.json");

  await mkdir(accountRoot, { recursive: true });
  await mkdir(sharedCodexHome, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(path.join(sharedCodexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', "utf8");

  const { events, logger } = createTestLogger();
  const registry = createAccountRegistry({
    accountRoot,
    logger,
    registryFile,
  });
  const work = await registry.addAccount({ label: "work" });
  const personal = await registry.addAccount({ label: "personal" });
  await writeAccountState(work, {
    accessToken: "token-work",
    accountId: work.id,
  });
  await writeAccountMetadata(work, {
    subscriptionPaidAt: "2026-05-04T00:00:00.000Z",
  });
  await writeAccountState(personal, {
    accessToken: "token-personal",
    accountId: personal.id,
  });
  await writeAccountMetadata(personal, {
    subscriptionPaidAt: "2026-05-05T00:00:00.000Z",
  });
  return {
    cacheFilePath,
    events,
    personal,
    registryFile,
    sharedCodexHome,
    work,
  };
}

function findEvent(
  events: LoggedEvent[],
  event: string,
  level?: LoggedEvent["level"],
): LoggedEvent | undefined {
  return events.find((entry) => entry.event === event && (!level || entry.level === level));
}

function createStubRegistry(accounts: AccountRecord[]): AccountRegistry {
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
    async renameAccount() {
      throw new Error("not implemented");
    },
    async removeAccount() {
      throw new Error("not implemented");
    },
    async selectAccount() {
      throw new Error("selectAccount should not be called in display-only mode");
    },
  };
}

function createAccountListContext(input: {
  cacheFilePath: string;
  events: LoggedEvent[];
  outputChunks: string[];
  registryFile: string;
  sharedCodexHome: string;
  stdoutIsTTY?: boolean;
  tempRoot: string;
}): AppContext {
  const stdout = {
    isTTY: input.stdoutIsTTY === true,
    write(chunk: string | Uint8Array) {
      input.outputChunks.push(String(chunk));
      return true;
    },
  } as NodeJS.WriteStream;

  return {
    argv: ["account", "list"],
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
            level: level.toLowerCase() as LoggedEvent["level"],
            event,
            details,
          });
        },
      },
    },
    paths: {
      projectRoot: process.cwd(),
      dataRoot: path.join(input.tempRoot, "data"),
      sharedCodexHome: input.sharedCodexHome,
      accountRoot: path.join(input.tempRoot, "data", "accounts"),
      runtimeRoot: path.join(input.tempRoot, "data", "runtime"),
      registryFile: input.registryFile,
      wrapperConfigFile: path.join(input.tempRoot, "data", "codexes.json"),
      codexConfigFile: path.join(input.sharedCodexHome, "config.toml"),
      selectionCacheFile: input.cacheFilePath,
    },
    runtimeInitialization: {
      firstRun: false,
      legacyCodexHome: path.join(input.tempRoot, "data", "legacy"),
      sharedCodexHome: input.sharedCodexHome,
      createdDirectories: [],
      createdFiles: [],
      copiedSharedArtifacts: [],
      skippedArtifacts: [],
    },
    wrapperConfig: {
      configFilePath: path.join(input.tempRoot, "data", "codexes.json"),
      codexConfigFilePath: path.join(input.sharedCodexHome, "config.toml"),
      selectionCacheFilePath: input.cacheFilePath,
      credentialStoreMode: "file",
      credentialStorePolicyReason: "file mode detected in Codex config",
      accountSelectionStrategy: "remaining-limit",
      accountSelectionStrategySource: "default",
      experimentalSelection: {
        enabled: true,
        probeTimeoutMs: 500,
        cacheTtlMs: 60_000,
        useAccountIdHeader: true,
      },
    },
    codexBinary: {
      path: null,
      candidates: [],
      rejectedCandidates: [],
    },
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

async function writeAccountMetadata(
  account: AccountRecord,
  input: Record<string, unknown>,
): Promise<void> {
  await mkdir(account.authDirectory, { recursive: true });
  await writeFile(
    path.join(account.authDirectory, "account.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        accountId: account.id,
        label: account.label,
        capturedAt: "2026-04-13T00:00:00.000Z",
        authMode: "chatgpt",
        authAccountId: account.id,
        lastRefresh: "2026-04-13T00:00:00.000Z",
        loginStatus: "succeeded",
        ...input,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
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

function subscriptionResponseForAccount(
  setup: {
    personal: AccountRecord;
    work: AccountRecord;
  },
  url: string | URL | Request,
): Response {
  const accountId = new URL(String(url)).searchParams.get("account_id");
  return jsonResponse({
    active_until:
      accountId === setup.work.id
        ? "2026-05-04T00:00:00.000Z"
        : "2026-05-15T00:00:00.000Z",
  });
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
