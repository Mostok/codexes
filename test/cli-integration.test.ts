import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createAccountRegistry } from "../src/accounts/account-registry.js";
import { createRuntimeContract, resolveAccountRuntimePaths } from "../src/runtime/runtime-contract.js";
import {
  createCodexShim,
  createTempDir,
  createTestLogger,
  readJson,
  removeTempDir,
} from "./test-helpers.js";

test("CLI passes unknown args and piped stdin through a single configured account", async (t) => {
  const tempRoot = await createTempDir("codexes-cli");
  t.after(async () => removeTempDir(tempRoot));

  const platformState = resolvePlatformStateRoot(tempRoot);
  const dataRoot = platformState.dataRoot;
  const sharedCodexHome = path.join(dataRoot, "shared-home");
  const binRoot = path.join(tempRoot, "bin");
  const childOutputFile = path.join(tempRoot, "child-output.json");
  const fakeCodexScript = path.join(tempRoot, "fake-codex.mjs");

  await mkdir(binRoot, { recursive: true });
  await writeFile(
    fakeCodexScript,
    [
      "import { readFile, writeFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      "const chunks = [];",
      "for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));",
      "const authFile = path.join(process.env.CODEX_HOME, 'auth.json');",
      "const auth = JSON.parse(await readFile(authFile, 'utf8'));",
      "auth.last_refresh = 'from-child';",
      "await writeFile(authFile, JSON.stringify(auth, null, 2));",
      "await writeFile(process.env.TEST_OUTPUT_FILE, JSON.stringify({",
      "  argv: process.argv.slice(2),",
      "  stdin: Buffer.concat(chunks).toString('utf8'),",
      "  codexHome: process.env.CODEX_HOME,",
      "}, null, 2));",
      "process.stdout.write('fake-codex-ok\\n');",
      "",
    ].join("\n"),
    "utf8",
  );
  await createCodexShim({ binRoot, scriptPath: fakeCodexScript });

  const { logger } = createTestLogger();
  const registry = createAccountRegistry({
    accountRoot: path.join(dataRoot, "accounts"),
    logger,
    registryFile: path.join(dataRoot, "registry.json"),
  });
  const account = await registry.addAccount({ label: "work" });
  const runtimeContract = createRuntimeContract({
    accountRoot: path.join(dataRoot, "accounts"),
    credentialStoreMode: "file",
    logger,
    runtimeRoot: path.join(dataRoot, "runtime"),
    sharedCodexHome,
  });
  const runtimePaths = resolveAccountRuntimePaths(runtimeContract, account.id);
  await mkdir(runtimePaths.accountStateDirectory, { recursive: true });
  await writeFile(
    path.join(runtimePaths.accountStateDirectory, "auth.json"),
    '{"tokens":{"account_id":"acct-work"},"last_refresh":"before-child"}\n',
    "utf8",
  );

  const childEnv = { ...process.env };
  delete childEnv.LOCALAPPDATA;
  delete childEnv.LocalAppData;
  delete childEnv.localappdata;
  delete childEnv.XDG_STATE_HOME;

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "--model", "gpt-5", "chat", "--json"],
    {
      cwd: process.cwd(),
      env: {
        ...childEnv,
        CODEX_HOME: sharedCodexHome,
        LOG_LEVEL: "ERROR",
        PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ""}`,
        TEST_OUTPUT_FILE: childOutputFile,
        ...platformState.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  child.stdin.end("stdin-payload");

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

  assert.equal(exitCode, 0, Buffer.concat(stderrChunks).toString("utf8"));
  assert.match(Buffer.concat(stdoutChunks).toString("utf8"), /fake-codex-ok/);

  const childOutput = await readJson<{
    argv: string[];
    stdin: string;
    codexHome: string;
  }>(childOutputFile);
  assert.deepEqual(childOutput.argv, ["--model", "gpt-5", "chat", "--json"]);
  assert.equal(childOutput.stdin, "stdin-payload");
  assert.notEqual(childOutput.codexHome, sharedCodexHome);
  assert.match(
    path.relative(path.join(dataRoot, "runtime", "executions"), childOutput.codexHome),
    /^.+[\\/]codex-home$/,
  );

  const syncedAuth = JSON.parse(
    await readFile(path.join(runtimePaths.accountStateDirectory, "auth.json"), "utf8"),
  ) as { last_refresh: string };
  assert.equal(syncedAuth.last_refresh, "from-child");
});

test("CLI hides structured fatal logs from user stderr by default", async (t) => {
  const tempRoot = await createTempDir("codexes-cli-fatal");
  t.after(async () => removeTempDir(tempRoot));

  const platformState = resolvePlatformStateRoot(tempRoot);
  const binRoot = path.join(tempRoot, "bin");
  const fakeCodexScript = path.join(tempRoot, "fake-codex.mjs");

  await mkdir(binRoot, { recursive: true });
  await writeFile(
    fakeCodexScript,
    "process.exit(0);\n",
    "utf8",
  );
  await createCodexShim({ binRoot, scriptPath: fakeCodexScript });

  const childEnv = { ...process.env };
  delete childEnv.LOCALAPPDATA;
  delete childEnv.LocalAppData;
  delete childEnv.localappdata;
  delete childEnv.XDG_STATE_HOME;
  delete childEnv.LOG_LEVEL;

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "chat"],
    {
      cwd: process.cwd(),
      env: {
        ...childEnv,
        PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ""}`,
        ...platformState.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  assert.equal(exitCode, 1, stderr);
  assert.equal(stdout.trim(), "");
  assert.match(stderr, /^codexes: No accounts configured\./m);
  assert.doesNotMatch(stderr, /bootstrap\.fatal/);
  assert.doesNotMatch(stderr, /"level":"ERROR"/);
  assert.doesNotMatch(stderr, /"event":/);
  assert.doesNotMatch(stderr, /stack/i);
});

test("CLI sanitizes context initialization failures before app context exists", async (t) => {
  const tempRoot = await createTempDir("codexes-cli-context-fatal");
  t.after(async () => removeTempDir(tempRoot));

  const stateRootFile = path.join(tempRoot, "state-root-file");
  await writeFile(stateRootFile, "not a directory", "utf8");

  const childEnv = { ...process.env };
  delete childEnv.LOCALAPPDATA;
  delete childEnv.LocalAppData;
  delete childEnv.localappdata;
  delete childEnv.XDG_STATE_HOME;
  delete childEnv.LOG_LEVEL;

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "chat"],
    {
      cwd: process.cwd(),
      env: {
        ...childEnv,
        ...resolveBrokenStateRootEnv(stateRootFile),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  assert.equal(exitCode, 1, stderr);
  assert.equal(stdout.trim(), "");
  assert.equal(
    stderr.trim(),
    "codexes: Command failed. Re-run with LOG_LEVEL=DEBUG to inspect diagnostics.",
  );
  assert.doesNotMatch(stderr, /Unhandled/i);
  assert.doesNotMatch(stderr, /ENOTDIR/);
  assert.doesNotMatch(stderr, new RegExp(stateRootFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(stderr, /node:fs/i);
  assert.doesNotMatch(stderr, /"event":/);
  assert.doesNotMatch(stderr, /stack/i);
});


test("CLI emits debug diagnostics for context initialization failures before app context exists", async (t) => {
  const tempRoot = await createTempDir("codexes-cli-context-debug");
  t.after(async () => removeTempDir(tempRoot));

  const stateRootFile = path.join(tempRoot, "state-root-file");
  await writeFile(stateRootFile, "not a directory", "utf8");

  const childEnv = { ...process.env };
  delete childEnv.LOCALAPPDATA;
  delete childEnv.LocalAppData;
  delete childEnv.localappdata;
  delete childEnv.XDG_STATE_HOME;

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "chat"],
    {
      cwd: process.cwd(),
      env: {
        ...childEnv,
        LOG_LEVEL: "DEBUG",
        ...resolveBrokenStateRootEnv(stateRootFile),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  assert.equal(exitCode, 1, stderr);
  assert.equal(stdout.trim(), "");
  assert.match(stderr, /"event":"bootstrap\.bootstrap\.fatal"/);
  assert.match(stderr, /"phase":"context_initialization"/);
  assert.match(stderr, /"message":"ENOTDIR:/);
  assert.match(
    stderr,
    /codexes: Command failed. Re-run with LOG_LEVEL=DEBUG to inspect diagnostics./,
  );
});

function resolveBrokenStateRootEnv(stateRootFile: string): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    return { LOCALAPPDATA: stateRootFile };
  }

  if (process.platform === "darwin") {
    return { HOME: stateRootFile };
  }

  return { XDG_STATE_HOME: stateRootFile };
}

function resolvePlatformStateRoot(tempRoot: string): {
  dataRoot: string;
  env: NodeJS.ProcessEnv;
} {
  if (process.platform === "win32") {
    const localAppData = path.join(tempRoot, "localappdata");
    return {
      dataRoot: path.join(localAppData, "codexes"),
      env: {
        LOCALAPPDATA: localAppData,
      },
    };
  }

  if (process.platform === "darwin") {
    const home = path.join(tempRoot, "home");
    return {
      dataRoot: path.join(home, "Library", "Application Support", "codexes"),
      env: {
        HOME: home,
      },
    };
  }

  const xdgStateHome = path.join(tempRoot, "xdg-state");
  return {
    dataRoot: path.join(xdgStateHome, "codexes"),
    env: {
      XDG_STATE_HOME: xdgStateHome,
    },
  };
}
