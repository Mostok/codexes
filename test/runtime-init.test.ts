import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ResolvedPaths } from "../src/core/paths.js";
import { initializeRuntimeEnvironment } from "../src/runtime/init/initialize-runtime.js";
import {
  assertEvent,
  createTempDir,
  createTestLogger,
  readJson,
  removeTempDir,
} from "./test-helpers.js";

test("runtime initialization links shared home to the live legacy Codex home", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-init");
  t.after(async () => removeTempDir(tempRoot));

  const legacyHomeRoot = path.join(tempRoot, "home");
  const legacyCodexHome = path.join(legacyHomeRoot, ".codex");
  const sharedCodexHome = path.join(tempRoot, "data", "shared-home");

  await mkdir(path.join(legacyCodexHome, "trust"), { recursive: true });
  await writeFile(
    path.join(legacyCodexHome, "config.toml"),
    'cli_auth_credentials_store = "keyring"\nmodel = "gpt-5"\n',
    "utf8",
  );
  await writeFile(path.join(legacyCodexHome, "mcp.json"), '{ "mcp": true }\n', "utf8");
  await writeFile(path.join(legacyCodexHome, "trust", "allow.txt"), "trusted\n", "utf8");

  t.mock.method(os, "homedir", () => legacyHomeRoot);

  const { events, logger } = createTestLogger();
  const paths = createResolvedPaths({ projectRoot: tempRoot, sharedCodexHome });

  const result = await initializeRuntimeEnvironment({
    env: {},
    logger,
    paths,
  });

  assert.equal(result.firstRun, true);
  assert.match(await readFile(path.join(sharedCodexHome, "config.toml"), "utf8"), /model = "gpt-5"/);
  assert.match(await readFile(path.join(sharedCodexHome, "mcp.json"), "utf8"), /"mcp": true/);
  assert.equal(
    (await readFile(path.join(sharedCodexHome, "trust", "allow.txt"), "utf8")).trim(),
    "trusted",
  );

  await writeFile(path.join(legacyCodexHome, "config.toml"), 'model = "gpt-5.4"\n', "utf8");
  await writeFile(path.join(legacyCodexHome, "mcp.json"), '{ "mcp": "live" }\n', "utf8");
  await writeFile(path.join(legacyCodexHome, "trust", "new.txt"), "live\n", "utf8");

  assert.match(await readFile(path.join(sharedCodexHome, "config.toml"), "utf8"), /gpt-5\.4/);
  assert.match(await readFile(path.join(sharedCodexHome, "mcp.json"), "utf8"), /"live"/);
  assert.equal((await readFile(path.join(sharedCodexHome, "trust", "new.txt"), "utf8")).trim(), "live");

  const registry = await readJson<{ schemaVersion: number; accounts: unknown[] }>(paths.registryFile);
  assert.equal(registry.schemaVersion, 1);
  assert.deepEqual(registry.accounts, []);

  assertEvent(events, "runtime_init.config_linked", "info");
  assertEvent(events, "runtime_init.file_linked", "info");
  assertEvent(events, "runtime_init.directory_artifact_linked", "info");
});

test("runtime initialization replaces stale shared artifacts with live links from legacy Codex home", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-init-refresh");
  t.after(async () => removeTempDir(tempRoot));

  const legacyHomeRoot = path.join(tempRoot, "home");
  const legacyCodexHome = path.join(legacyHomeRoot, ".codex");
  const sharedCodexHome = path.join(tempRoot, "data", "shared-home");

  await mkdir(path.join(legacyCodexHome, "trust"), { recursive: true });
  await mkdir(path.join(sharedCodexHome, "trust"), { recursive: true });
  await writeFile(path.join(legacyCodexHome, "config.toml"), 'model = "fresh"\n', "utf8");
  await writeFile(path.join(legacyCodexHome, "mcp.json"), '{ "mcp": "fresh" }\n', "utf8");
  await writeFile(path.join(legacyCodexHome, "trust", "source.txt"), "source\n", "utf8");
  await writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "stale"\n', "utf8");
  await writeFile(path.join(sharedCodexHome, "mcp.json"), '{ "mcp": "stale" }\n', "utf8");
  await writeFile(path.join(sharedCodexHome, "trust", "source.txt"), "stale\n", "utf8");

  t.mock.method(os, "homedir", () => legacyHomeRoot);

  const { events, logger } = createTestLogger();
  const paths = createResolvedPaths({ projectRoot: tempRoot, sharedCodexHome });

  await initializeRuntimeEnvironment({
    env: {},
    logger,
    paths,
  });

  assert.match(await readFile(path.join(sharedCodexHome, "config.toml"), "utf8"), /fresh/);
  assert.match(await readFile(path.join(sharedCodexHome, "mcp.json"), "utf8"), /fresh/);
  assert.equal(
    (await readFile(path.join(sharedCodexHome, "trust", "source.txt"), "utf8")).trim(),
    "source",
  );

  await writeFile(path.join(legacyCodexHome, "config.toml"), 'model = "fresher"\n', "utf8");
  assert.match(await readFile(path.join(sharedCodexHome, "config.toml"), "utf8"), /fresher/);

  assertEvent(events, "runtime_init.config_linked", "info");
  assertEvent(events, "runtime_init.file_linked", "info");
  assertEvent(events, "runtime_init.directory_artifact_linked", "info");
});

test("runtime initialization keeps config and mcp links live after atomic source replacement", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-init-atomic-refresh");
  t.after(async () => removeTempDir(tempRoot));

  const legacyHomeRoot = path.join(tempRoot, "home");
  const legacyCodexHome = path.join(legacyHomeRoot, ".codex");
  const sharedCodexHome = path.join(tempRoot, "data", "shared-home");

  await mkdir(legacyCodexHome, { recursive: true });
  await writeFile(path.join(legacyCodexHome, "config.toml"), 'model = "before"\n', "utf8");
  await writeFile(path.join(legacyCodexHome, "mcp.json"), '{ "mcp": "before" }\n', "utf8");

  t.mock.method(os, "homedir", () => legacyHomeRoot);

  const { logger } = createTestLogger();
  const paths = createResolvedPaths({ projectRoot: tempRoot, sharedCodexHome });

  await initializeRuntimeEnvironment({ env: {}, logger, paths });


  await writeFile(path.join(legacyCodexHome, "config.toml.tmp"), 'model = "after"\n', "utf8");
  await rename(path.join(legacyCodexHome, "config.toml.tmp"), path.join(legacyCodexHome, "config.toml"));
  await writeFile(path.join(legacyCodexHome, "mcp.json.tmp"), '{ "mcp": "after" }\n', "utf8");
  await rename(path.join(legacyCodexHome, "mcp.json.tmp"), path.join(legacyCodexHome, "mcp.json"));

  await initializeRuntimeEnvironment({ env: {}, logger, paths });

  assert.match(await readFile(path.join(sharedCodexHome, "config.toml"), "utf8"), /after/);
  assert.match(await readFile(path.join(sharedCodexHome, "mcp.json"), "utf8"), /after/);
});

test("runtime initialization creates fallback config when legacy Codex home is missing", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-init-fallback");
  t.after(async () => removeTempDir(tempRoot));

  const legacyHomeRoot = path.join(tempRoot, "home");
  const sharedCodexHome = path.join(tempRoot, "data", "shared-home");

  t.mock.method(os, "homedir", () => legacyHomeRoot);

  const { events, logger } = createTestLogger();
  const paths = createResolvedPaths({ projectRoot: tempRoot, sharedCodexHome });

  await initializeRuntimeEnvironment({
    env: {},
    logger,
    paths,
  });

  const sharedConfig = await readFile(path.join(sharedCodexHome, "config.toml"), "utf8");
  assert.match(sharedConfig, /cli_auth_credentials_store = "file"/);
  assertEvent(events, "runtime_init.config_created", "info");
});

function createResolvedPaths(input: {
  projectRoot: string;
  sharedCodexHome: string;
}): ResolvedPaths {
  return {
    projectRoot: input.projectRoot,
    dataRoot: path.join(input.projectRoot, "data"),
    sharedCodexHome: input.sharedCodexHome,
    accountRoot: path.join(input.projectRoot, "data", "accounts"),
    runtimeRoot: path.join(input.projectRoot, "data", "runtime"),
    executionRoot: path.join(input.projectRoot, "data", "runtime", "executions"),
    registryFile: path.join(input.projectRoot, "data", "registry.json"),
    wrapperConfigFile: path.join(input.projectRoot, "data", "codexes.json"),
    codexConfigFile: path.join(input.sharedCodexHome, "config.toml"),
    selectionCacheFile: path.join(input.projectRoot, "data", "selection-cache.json"),
  };
}
