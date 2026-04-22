import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createAccountRegistry } from "../src/accounts/account-registry.js";
import { runRootCommand } from "../src/commands/root/run-root-command.js";
import type { AppContext } from "../src/core/context.js";
import { createRuntimeContract, resolveAccountRuntimePaths } from "../src/runtime/runtime-contract.js";
import {
  assertEvent,
  createCodexShim,
  createTempDir,
  createTestLogger,
  removeTempDir,
  waitForPath,
} from "./test-helpers.js";

test("runRootCommand skips account sync-back when the child codex process fails", async (t) => {
  const tempRoot = await createTempDir("codexes-root-failed-child");
  t.after(async () => removeTempDir(tempRoot));

  const dataRoot = path.join(tempRoot, "data");
  const accountRoot = path.join(dataRoot, "accounts");
  const sharedCodexHome = path.join(dataRoot, "shared-home");
  const runtimeRoot = path.join(dataRoot, "runtime");
  const executionRoot = path.join(runtimeRoot, "executions");
  const registryFile = path.join(dataRoot, "registry.json");
  const binRoot = path.join(tempRoot, "bin");
  const fakeCodexScript = path.join(tempRoot, "fake-codex.mjs");

  await mkdir(sharedCodexHome, { recursive: true });
  await mkdir(accountRoot, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(path.join(sharedCodexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', "utf8");
  await writeFile(
    fakeCodexScript,
    [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      "await writeFile(path.join(process.env.CODEX_HOME, 'auth.json'), '{\\\"last_refresh\\\":\\\"failed-child\\\"}\\\\n', 'utf8');",
      "await mkdir(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true });",
      "await writeFile(path.join(process.env.CODEX_HOME, 'sessions', 'failed.json'), '{}\\\\n', 'utf8');",
      "await mkdir(path.join(process.env.CODEX_HOME, 'trust'), { recursive: true });",
      "await writeFile(path.join(process.env.CODEX_HOME, 'trust', 'failed.txt'), 'shared-trust\\\\n', 'utf8');",
      "await writeFile(path.join(process.env.CODEX_HOME, 'mcp.json'), '{\\\"mcpServers\\\":{\\\"unsafe\\\":{\\\"command\\\":\\\"node\\\"}}}\\\\n', 'utf8');",
      "process.exit(7);",
      "",
    ].join("\n"),
    "utf8",
  );
  const codexBinaryPath = await createCodexShim({ binRoot, scriptPath: fakeCodexScript });

  const { events, logger } = createTestLogger();
  const registry = createAccountRegistry({
    accountRoot,
    logger,
    registryFile,
  });
  const account = await registry.addAccount({ label: "work" });
  const contract = createRuntimeContract({
    accountRoot,
    credentialStoreMode: "file",
    executionRoot,
    logger,
    runtimeRoot,
    sharedCodexHome,
  });
  const runtimePaths = resolveAccountRuntimePaths(contract, account.id);

  await mkdir(runtimePaths.accountStateDirectory, { recursive: true });
  await writeFile(
    path.join(runtimePaths.accountStateDirectory, "auth.json"),
    '{"last_refresh":"before-child"}\n',
    "utf8",
  );

  const context = createRootCommandContext({
    argv: ["chat"],
    codexBinaryPath,
    dataRoot,
    events,
    executionRoot,
    registryFile,
    runtimeRoot,
    sharedCodexHome,
  });

  const exitCode = await runRootCommand(context);

  assert.equal(exitCode, 7);
  assert.match(
    await readFile(path.join(runtimePaths.accountStateDirectory, "auth.json"), "utf8"),
    /before-child/,
  );
  assert.equal(
    await stat(path.join(runtimePaths.accountStateDirectory, "sessions", "failed.json")).catch(
      () => null,
    ),
    null,
  );
  assert.equal(await stat(path.join(sharedCodexHome, "sessions", "failed.json")).catch(() => null), null);
  assert.match(
    await readFile(path.join(sharedCodexHome, "trust", "failed.txt"), "utf8"),
    /shared-trust/,
  );
  assert.equal(await stat(path.join(sharedCodexHome, "mcp.json")).catch(() => null), null);

  await writeFile(
    fakeCodexScript,
    [
      "import { readFile, writeFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      "const auth = await readFile(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8');",
      "await writeFile(path.join(process.env.CODEX_HOME, 'observed-auth.txt'), auth, 'utf8');",
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf8",
  );

  const secondExitCode = await runRootCommand(context);
  assert.equal(secondExitCode, 0);
  assert.match(
    await readFile(
      path.join(runtimePaths.accountStateDirectory, "codex-home", "observed-auth.txt"),
      "utf8",
    ),
    /before-child/,
  );
  assertEvent(events, "root.runtime_model.isolated_execution.shared_sync_back.complete", "info");
  assertEvent(events, "root.runtime_model.isolated_execution.sync_back_skipped", "warn");
  assert.equal(
    events.some(
      (entry) =>
        entry.event === "root.runtime_model.isolated_execution.account_lock_acquiring" &&
        entry.details?.purpose === "account-sync-back",
    ),
    false,
  );
});

test("runRootCommand allows concurrent isolated children on the same account and serializes sync-back", async (t) => {
  const tempRoot = await createTempDir("codexes-root-concurrent-same-account");
  t.after(async () => removeTempDir(tempRoot));

  const dataRoot = path.join(tempRoot, "data");
  const accountRoot = path.join(dataRoot, "accounts");
  const sharedCodexHome = path.join(dataRoot, "shared-home");
  const runtimeRoot = path.join(dataRoot, "runtime");
  const executionRoot = path.join(runtimeRoot, "executions");
  const registryFile = path.join(dataRoot, "registry.json");
  const binRoot = path.join(tempRoot, "bin");
  const controlRoot = path.join(tempRoot, "control");
  const fakeCodexScript = path.join(tempRoot, "fake-codex-concurrent.mjs");

  await mkdir(sharedCodexHome, { recursive: true });
  await mkdir(accountRoot, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(controlRoot, { recursive: true });
  await writeFile(path.join(sharedCodexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', "utf8");
  await writeFile(
    fakeCodexScript,
    [
      "import { mkdir, stat, writeFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      `const controlRoot = ${JSON.stringify(controlRoot)};`,
      "const runId = process.argv[2] ?? 'unknown';",
      "const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));",
      "await mkdir(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true });",
      "await writeFile(path.join(controlRoot, `started-${runId}`), process.env.CODEX_HOME, 'utf8');",
      "for (let index = 0; index < 200; index += 1) {",
      "  if (await stat(path.join(controlRoot, 'release')).catch(() => null)) break;",
      "  await sleep(25);",
      "}",
      "await writeFile(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ last_refresh: runId }) + '\\n', 'utf8');",
      "await writeFile(path.join(process.env.CODEX_HOME, 'sessions', `${runId}.json`), JSON.stringify({ session: runId }) + '\\n', 'utf8');",
      "",
    ].join("\n"),
    "utf8",
  );
  const codexBinaryPath = await createCodexShim({ binRoot, scriptPath: fakeCodexScript });

  const { logger } = createTestLogger();
  const registry = createAccountRegistry({
    accountRoot,
    logger,
    registryFile,
  });
  const account = await registry.addAccount({ label: "work" });
  const contract = createRuntimeContract({
    accountRoot,
    credentialStoreMode: "file",
    executionRoot,
    logger,
    runtimeRoot,
    sharedCodexHome,
  });
  const runtimePaths = resolveAccountRuntimePaths(contract, account.id);

  await mkdir(runtimePaths.accountStateDirectory, { recursive: true });
  await writeFile(
    path.join(runtimePaths.accountStateDirectory, "auth.json"),
    '{"last_refresh":"before-child"}\n',
    "utf8",
  );

  const events: Array<{
    details: Record<string, unknown> | undefined;
    event: string;
    level: "debug" | "info" | "warn" | "error";
  }> = [];

  const firstRun = runRootCommand(createRootCommandContext({
    argv: ["first"],
    codexBinaryPath,
    dataRoot,
    events,
    executionRoot,
    registryFile,
    runtimeRoot,
    sharedCodexHome,
  }));
  await waitForPath(path.join(controlRoot, "started-first"));

  const secondRun = runRootCommand(createRootCommandContext({
    argv: ["second"],
    codexBinaryPath,
    dataRoot,
    events,
    executionRoot,
    registryFile,
    runtimeRoot,
    sharedCodexHome,
  }));
  await waitForPath(path.join(controlRoot, "started-second"), 2_000);

  await writeFile(path.join(controlRoot, "release"), "1", "utf8");

  assert.deepEqual(await Promise.all([firstRun, secondRun]), [0, 0]);
  assert.match(
    await readFile(path.join(runtimePaths.accountStateDirectory, "sessions", "first.json"), "utf8"),
    /first/,
  );
  assert.match(
    await readFile(path.join(runtimePaths.accountStateDirectory, "sessions", "second.json"), "utf8"),
    /second/,
  );
  assertEvent(events, "root.runtime_model.isolated_execution.child_run.start", "info");
  assertEvent(events, "root.runtime_model.isolated_execution.account_sync_back.start", "info");
  assert.equal(
    events.some((entry) => entry.event.includes("lock")),
    false,
  );
});

function createRootCommandContext(input: {
  argv: string[];
  codexBinaryPath: string;
  dataRoot: string;
  events: Array<{
    details: Record<string, unknown> | undefined;
    event: string;
    level: "debug" | "info" | "warn" | "error";
  }>;
  executionRoot: string;
  registryFile: string;
  runtimeRoot: string;
  sharedCodexHome: string;
}): AppContext {
  const stdout = {
    isTTY: false,
    write() {
      return true;
    },
  } as unknown as NodeJS.WriteStream;

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
      stderr: { write() { return true; } } as unknown as NodeJS.WriteStream,
    },
    output: {
      stdoutIsTTY: false,
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
      executionRoot: input.executionRoot,
      registryFile: input.registryFile,
      wrapperConfigFile: path.join(input.dataRoot, "codexes.json"),
      codexConfigFile: path.join(input.sharedCodexHome, "config.toml"),
      selectionCacheFile: path.join(input.dataRoot, "selection-cache.json"),
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
      selectionCacheFilePath: path.join(input.dataRoot, "selection-cache.json"),
      credentialStoreMode: "file",
      credentialStorePolicyReason: "file mode detected in Codex config",
      accountSelectionStrategy: "manual-default",
      accountSelectionStrategySource: "default",
      runtimeModel: "isolated-execution",
      runtimeModelSource: "default",
      experimentalSelection: {
        enabled: false,
        probeTimeoutMs: 500,
        cacheTtlMs: 60_000,
        useAccountIdHeader: true,
      },
    },
    codexBinary: {
      path: input.codexBinaryPath,
      candidates: [input.codexBinaryPath],
      rejectedCandidates: [],
    },
  };
}
