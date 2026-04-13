import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { findCodexBinary } from "../src/process/find-codex-binary.js";
import {
  assertEvent,
  createTempDir,
  createTestLogger,
  removeTempDir,
} from "./test-helpers.js";

function codexExecutableName(): string {
  return process.platform === "win32" ? "codex.cmd" : "codex";
}

test("binary discovery returns null when no real codex binary exists", async (t) => {
  const tempRoot = await createTempDir("codexes-find-binary-missing");
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  const result = await findCodexBinary({
    env: {
      PATH: path.join(tempRoot, "missing-bin"),
    },
    logger,
    wrapperExecutablePath: path.join(tempRoot, "wrapper.js"),
  });

  assert.equal(result.path, null);
  assert.ok(result.candidates.length > 0);
  assertEvent(events, "binary_resolution.missing", "warn");
});

test("binary discovery rejects self-recursive wrapper paths", async (t) => {
  const tempRoot = await createTempDir("codexes-find-binary-self");
  t.after(async () => removeTempDir(tempRoot));

  const binRoot = path.join(tempRoot, "bin");
  await mkdir(binRoot, { recursive: true });
  const wrapperPath = path.join(binRoot, codexExecutableName());
  await writeFile(wrapperPath, "echo wrapper\n", "utf8");

  const { logger } = createTestLogger();
  const result = await findCodexBinary({
    env: {
      PATH: binRoot,
    },
    logger,
    wrapperExecutablePath: wrapperPath,
  });

  assert.equal(result.path, null);
  assert.ok(
    result.rejectedCandidates.some(
      (entry) =>
        entry.candidate === wrapperPath && entry.reason === "self_recursive_wrapper_path",
    ),
  );
});
