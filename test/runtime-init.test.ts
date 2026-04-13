import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

test("runtime initialization bootstraps shared home from the legacy Codex home", async (t) => {
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
  await writeFile(path.join(legacyCodexHome, "mcp.json"), "{ \"mcp\": true }\n", "utf8");
  await writeFile(path.join(legacyCodexHome, "trust", "allow.txt"), "trusted\n", "utf8");

  t.mock.method(os, "homedir", () => legacyHomeRoot);

  const { events, logger } = createTestLogger();
  const paths: ResolvedPaths = {
    projectRoot: tempRoot,
    dataRoot: path.join(tempRoot, "data"),
    sharedCodexHome,
    accountRoot: path.join(tempRoot, "data", "accounts"),
    runtimeRoot: path.join(tempRoot, "data", "runtime"),
    registryFile: path.join(tempRoot, "data", "registry.json"),
    wrapperConfigFile: path.join(tempRoot, "data", "codexes.json"),
    codexConfigFile: path.join(sharedCodexHome, "config.toml"),
    selectionCacheFile: path.join(tempRoot, "data", "selection-cache.json"),
  };

  const result = await initializeRuntimeEnvironment({
    env: {},
    logger,
    paths,
  });

  assert.equal(result.firstRun, true);

  const sharedConfig = await readFile(path.join(sharedCodexHome, "config.toml"), "utf8");
  assert.match(sharedConfig, /cli_auth_credentials_store = "file"/);
  assert.match(sharedConfig, /model = "gpt-5"/);

  const sharedMcp = await readFile(path.join(sharedCodexHome, "mcp.json"), "utf8");
  assert.match(sharedMcp, /"mcp": true/);

  const trustContent = await readFile(path.join(sharedCodexHome, "trust", "allow.txt"), "utf8");
  assert.equal(trustContent.trim(), "trusted");

  const registry = await readJson<{ schemaVersion: number; accounts: unknown[] }>(paths.registryFile);
  assert.equal(registry.schemaVersion, 1);
  assert.deepEqual(registry.accounts, []);

  assertEvent(events, "runtime_init.config_imported", "info");
  assertEvent(events, "runtime_init.file_copied", "info");
  assertEvent(events, "runtime_init.directory_artifact_copied", "info");
});
