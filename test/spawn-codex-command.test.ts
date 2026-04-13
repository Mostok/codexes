import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { spawnCodexCommand } from "../src/process/spawn-codex-command.js";
import {
  assertEvent,
  createTempDir,
  createTestLogger,
  removeTempDir,
  waitForPath,
} from "./test-helpers.js";

test("spawnCodexCommand passes through argv and CODEX_HOME", async (t) => {
  const tempRoot = await createTempDir("codexes-spawn");
  t.after(async () => removeTempDir(tempRoot));

  const outputFile = path.join(tempRoot, "output.json");
  const scriptPath = path.join(tempRoot, "fake-codex.mjs");
  await writeFile(
    scriptPath,
    [
      "import { writeFile } from 'node:fs/promises';",
      "await writeFile(process.env.TEST_OUTPUT_FILE, JSON.stringify({",
      "  argv: process.argv.slice(2),",
      "  codexHome: process.env.CODEX_HOME ?? null,",
      "}, null, 2));",
      "process.exit(Number(process.argv[2]?.replace('--exit=', '') ?? 0));",
      "",
    ].join("\n"),
    "utf8",
  );

  const { events, logger } = createTestLogger();
  const previousOutput = process.env.TEST_OUTPUT_FILE;
  process.env.TEST_OUTPUT_FILE = outputFile;
  t.after(() => {
    if (previousOutput === undefined) {
      delete process.env.TEST_OUTPUT_FILE;
      return;
    }

    process.env.TEST_OUTPUT_FILE = previousOutput;
  });

  const exitCode = await spawnCodexCommand({
    argv: [scriptPath, "--exit=7", "--model", "gpt-5"],
    codexBinaryPath: process.execPath,
    codexHome: path.join(tempRoot, "shared-home"),
    logger,
  });

  assert.equal(exitCode, 7);
  const payload = JSON.parse(await readFile(outputFile, "utf8")) as {
    argv: string[];
    codexHome: string;
  };
  assert.deepEqual(payload.argv, ["--exit=7", "--model", "gpt-5"]);
  assert.match(payload.codexHome, /shared-home$/);
  assertEvent(events, "spawn_codex.complete", "info");
});

test("spawnCodexCommand forwards termination signals to the child process", async (t) => {
  const tempRoot = await createTempDir("codexes-spawn-signal");
  t.after(async () => removeTempDir(tempRoot));

  const signalFile = path.join(tempRoot, "signal.txt");
  const childScript = path.join(tempRoot, "wait-for-signal.mjs");
  await writeFile(
    childScript,
    [
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.TEST_SIGNAL_FILE, 'ready');",
      "process.on('SIGTERM', () => {",
      "  appendFileSync(process.env.TEST_SIGNAL_FILE, '\\nSIGTERM');",
      "  process.exit(0);",
      "});",
      "setInterval(() => {}, 50);",
      "",
    ].join("\n"),
    "utf8",
  );

  const { events, logger } = createTestLogger();
  const previousSignalFile = process.env.TEST_SIGNAL_FILE;
  process.env.TEST_SIGNAL_FILE = signalFile;
  t.after(() => {
    if (previousSignalFile === undefined) {
      delete process.env.TEST_SIGNAL_FILE;
      return;
    }

    process.env.TEST_SIGNAL_FILE = previousSignalFile;
  });

  const promise = spawnCodexCommand({
    argv: [childScript],
    codexBinaryPath: process.execPath,
    codexHome: path.join(tempRoot, "shared-home"),
    logger,
  });

  await waitForPath(signalFile);
  process.emit("SIGTERM", "SIGTERM");

  const exitCode = await promise;
  assert.equal(typeof exitCode, "number");
  assertEvent(events, "spawn_codex.parent_signal", "warn");
});
