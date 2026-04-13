import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { resolveCodexLaunchSpec } from "../src/process/codex-launch-spec.js";
import { createTempDir, removeTempDir } from "./test-helpers.js";

test("resolveCodexLaunchSpec keeps direct execution on non-Windows", async (t) => {
  if (process.platform === "win32") {
    return;
  }

  const spec = await resolveCodexLaunchSpec("/usr/bin/codex", ["login"]);
  assert.equal(spec.command, "/usr/bin/codex");
  assert.deepEqual(spec.args, ["login"]);
});

test("resolveCodexLaunchSpec unwraps npm Codex shims on Windows", async (t) => {
  if (process.platform !== "win32") {
    return;
  }

  const tempRoot = await createTempDir("codexes-launch-spec");
  t.after(async () => removeTempDir(tempRoot));

  const shimDirectory = path.join(tempRoot, "nodejs");
  const scriptPath = path.join(shimDirectory, "node_modules", "@openai", "codex", "bin", "codex.js");
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, "console.log('codex');\n", "utf8");
  await writeFile(path.join(shimDirectory, "node.exe"), "", "utf8");

  const spec = await resolveCodexLaunchSpec(
    path.join(shimDirectory, "codex.cmd"),
    ["login"],
  );

  assert.equal(spec.command, path.join(shimDirectory, "node.exe"));
  assert.deepEqual(spec.args, [scriptPath, "login"]);
});
