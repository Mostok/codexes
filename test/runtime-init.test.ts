import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
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

test("runtime initialization bootstraps wrapper state without creating shared-home snapshots", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-init");
  t.after(async () => removeTempDir(tempRoot));

  const liveCodexHome = path.join(tempRoot, "live-codex-home");
  await mkdir(liveCodexHome, { recursive: true });
  await writeFile(path.join(liveCodexHome, "config.toml"), 'model = "gpt-5"\n', "utf8");

  const { events, logger } = createTestLogger();
  const paths = createResolvedPaths({ projectRoot: tempRoot, sharedCodexHome: liveCodexHome });

  const result = await initializeRuntimeEnvironment({
    env: {},
    logger,
    paths,
  });

  assert.equal(result.firstRun, true);
  assert.equal(result.sharedCodexHome, liveCodexHome);
  assert.equal(await stat(path.join(paths.dataRoot, "shared-home")).catch(() => null), null);

  const registry = await readJson<{ schemaVersion: number; accounts: unknown[] }>(paths.registryFile);
  assert.equal(registry.schemaVersion, 1);
  assert.deepEqual(registry.accounts, []);

  assertEvent(events, "runtime_init.path_model", "debug");
  assertEvent(events, "runtime_init.live_codex_home_ready", "debug");
  assertEvent(events, "runtime_init.registry_bootstrap", "info");
  assertEvent(events, "runtime_init.complete", "info");
});

test("runtime initialization reuses an existing registry and keeps live codex home untouched", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-init-reuse");
  t.after(async () => removeTempDir(tempRoot));

  const liveCodexHome = path.join(tempRoot, "live-codex-home");
  const dataRoot = path.join(tempRoot, "data");
  await mkdir(liveCodexHome, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(liveCodexHome, "config.toml"), 'model = "before"\n', "utf8");
  await writeFile(
    path.join(dataRoot, "registry.json"),
    JSON.stringify({ schemaVersion: 1, accounts: [{ id: "acct-1" }] }, null, 2),
    "utf8",
  );

  const { events, logger } = createTestLogger();
  const paths = createResolvedPaths({ projectRoot: tempRoot, sharedCodexHome: liveCodexHome });

  const result = await initializeRuntimeEnvironment({
    env: {},
    logger,
    paths,
  });

  assert.equal(result.firstRun, false);
  assert.deepEqual(
    await readJson<{ schemaVersion: number; accounts: Array<{ id: string }> }>(paths.registryFile),
    { schemaVersion: 1, accounts: [{ id: "acct-1" }] },
  );
  assert.equal(await stat(path.join(paths.dataRoot, "shared-home")).catch(() => null), null);
  assertEvent(events, "runtime_init.registry_exists", "debug");
});

test("runtime initialization warns when the live codex home is missing but still prepares wrapper directories", async (t) => {
  const tempRoot = await createTempDir("codexes-runtime-init-missing-home");
  t.after(async () => removeTempDir(tempRoot));

  const missingCodexHome = path.join(tempRoot, "missing-codex-home");
  const { events, logger } = createTestLogger();
  const paths = createResolvedPaths({ projectRoot: tempRoot, sharedCodexHome: missingCodexHome });

  await initializeRuntimeEnvironment({
    env: {},
    logger,
    paths,
  });

  assert.ok(await stat(paths.accountRoot).catch(() => null));
  assert.ok(await stat(paths.runtimeRoot).catch(() => null));
  assertEvent(events, "runtime_init.live_codex_home_missing", "warn");
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
