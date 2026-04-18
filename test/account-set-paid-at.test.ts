import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseAccountPaidDate } from "../src/accounts/account-paid-date.js";
import { createAccountRegistry, type AccountRecord } from "../src/accounts/account-registry.js";
import { runAccountSetPaidAtCommand } from "../src/commands/account-set-paid-at/run-account-set-paid-at-command.js";
import type { AppContext } from "../src/core/context.js";
import type { LoggedEvent } from "./test-helpers.js";
import { assertEvent, createTempDir, createTestLogger, removeTempDir } from "./test-helpers.js";

test("parseAccountPaidDate normalizes valid dd.mm.yyyy input", () => {
  const { events, logger } = createTestLogger();

  const parsed = parseAccountPaidDate({
    logger,
    rawValue: "18.04.2026",
    source: "test",
  });

  assert.deepEqual(parsed, {
    displayValue: "18.04.2026",
    isoValue: "2026-04-18T00:00:00.000Z",
  });
  assertEvent(events, "account_paid_date.parse_complete", "debug");
});

test("parseAccountPaidDate rejects invalid calendar dates", () => {
  const { events, logger } = createTestLogger();

  assert.throws(
    () =>
      parseAccountPaidDate({
        logger,
        rawValue: "31.02.2026",
        source: "test",
      }),
    /Invalid paid date "31\.02\.2026"/,
  );
  assertEvent(events, "account_paid_date.parse_invalid_calendar_date", "warn");
});

test("account set-paid-at updates metadata by label", async (t) => {
  const tempRoot = await createTempDir("codexes-account-set-paid-at-label");
  t.after(async () => removeTempDir(tempRoot));

  const setup = await createAccountCommandFixture(tempRoot);
  const outputChunks: string[] = [];
  const context = createAccountCommandContext({
    events: setup.events,
    outputChunks,
    registryFile: setup.registryFile,
    sharedCodexHome: setup.sharedCodexHome,
    tempRoot,
  });

  assert.equal(await runAccountSetPaidAtCommand(context, ["work", "18.04.2026"]), 0);
  assert.match(outputChunks.join(""), /Updated payed date for "work" .* to 18\.04\.2026\./);

  const metadata = JSON.parse(
    await readFile(path.join(setup.work.authDirectory, "account.json"), "utf8"),
  ) as { subscriptionPaidAt?: string };
  assert.equal(metadata.subscriptionPaidAt, "2026-04-18T00:00:00.000Z");
  assertEvent(setup.events, "account_set_paid_at.command.start", "info");
  assertEvent(setup.events, "account_set_paid_at.account_metadata.paid_at_updated", "info");
});

test("account set-paid-at updates metadata by id", async (t) => {
  const tempRoot = await createTempDir("codexes-account-set-paid-at-id");
  t.after(async () => removeTempDir(tempRoot));

  const setup = await createAccountCommandFixture(tempRoot);
  const outputChunks: string[] = [];
  const context = createAccountCommandContext({
    events: setup.events,
    outputChunks,
    registryFile: setup.registryFile,
    sharedCodexHome: setup.sharedCodexHome,
    tempRoot,
  });

  assert.equal(await runAccountSetPaidAtCommand(context, [setup.work.id, "20.04.2026"]), 0);

  const metadata = JSON.parse(
    await readFile(path.join(setup.work.authDirectory, "account.json"), "utf8"),
  ) as { subscriptionPaidAt?: string };
  assert.equal(metadata.subscriptionPaidAt, "2026-04-20T00:00:00.000Z");
});

async function createAccountCommandFixture(tempRoot: string): Promise<{
  events: LoggedEvent[];
  registryFile: string;
  sharedCodexHome: string;
  work: AccountRecord;
}> {
  const dataRoot = path.join(tempRoot, "data");
  const accountRoot = path.join(dataRoot, "accounts");
  const sharedCodexHome = path.join(dataRoot, "shared-home");
  const runtimeRoot = path.join(dataRoot, "runtime");
  const registryFile = path.join(dataRoot, "registry.json");

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

  await writeAccountMetadata(work, {
    subscriptionPaidAt: "2026-04-01T00:00:00.000Z",
  });

  return {
    events,
    registryFile,
    sharedCodexHome,
    work,
  };
}

function createAccountCommandContext(input: {
  events: LoggedEvent[];
  outputChunks: string[];
  registryFile: string;
  sharedCodexHome: string;
  tempRoot: string;
}): AppContext {
  const stdout = {
    isTTY: false,
    write(chunk: string | Uint8Array) {
      input.outputChunks.push(String(chunk));
      return true;
    },
  } as NodeJS.WriteStream;

  return {
    argv: ["account", "set-paid-at"],
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
      stdoutIsTTY: false,
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
      selectionCacheFile: path.join(input.tempRoot, "data", "selection-cache.json"),
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
      selectionCacheFilePath: path.join(input.tempRoot, "data", "selection-cache.json"),
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
