import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("package metadata supports global CLI install and public npm publishing", async () => {
  const packageJsonPath = path.join(process.cwd(), "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    bin?: Record<string, string>;
    name?: string;
    prepare?: string;
    publishConfig?: {
      registry?: string;
    };
    repository?: {
      type?: string;
      url?: string;
    };
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.name, "@mostok/codexes");
  assert.equal(packageJson.bin?.codexes, "dist/cli.js");
  assert.equal(packageJson.scripts?.prepare, "npm run build");
  assert.equal(packageJson.publishConfig?.registry, "https://registry.npmjs.org/");
  assert.equal(packageJson.repository?.type, "git");
  assert.equal(packageJson.repository?.url, "git+https://github.com/Mostok/codexes.git");
});
