import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { createAccountRegistry } from "../src/accounts/account-registry.js";
import {
  assertEvent,
  createTempDir,
  createTestLogger,
  readJson,
  removeTempDir,
} from "./test-helpers.js";

test("account registry adds, selects, removes, and persists accounts", async (t) => {
  const tempRoot = await createTempDir("codexes-registry");
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  const registryFile = path.join(tempRoot, "registry.json");
  const registry = createAccountRegistry({
    accountRoot: path.join(tempRoot, "accounts"),
    logger,
    registryFile,
  });

  const first = await registry.addAccount({ label: "work" });
  const second = await registry.addAccount({ label: "personal" });

  await assert.rejects(() => registry.addAccount({ label: " Work " }), /already exists/i);

  const selected = await registry.selectAccount(second.id);
  assert.equal(selected.id, second.id);
  assert.ok(selected.lastUsedAt);

  const removed = await registry.removeAccount(first.id);
  assert.equal(removed.id, first.id);

  const accounts = await registry.listAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.id, second.id);

  const persisted = await readJson<{
    defaultAccountId: string | null;
    accounts: Array<{ id: string }>;
  }>(registryFile);
  assert.equal(persisted.defaultAccountId, second.id);
  assert.deepEqual(
    persisted.accounts.map((account) => account.id),
    [second.id],
  );

  assertEvent(events, "registry.account_added", "info");
  assertEvent(events, "registry.account_selected", "info");
  assertEvent(events, "registry.account_removed", "info");
});

test("account registry recovers from corrupt documents by backing them up", async (t) => {
  const tempRoot = await createTempDir("codexes-registry-corrupt");
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  const registryFile = path.join(tempRoot, "registry.json");
  await writeFile(registryFile, "{not-json", "utf8");

  const registry = createAccountRegistry({
    accountRoot: path.join(tempRoot, "accounts"),
    logger,
    registryFile,
  });

  const accounts = await registry.listAccounts();
  assert.deepEqual(accounts, []);

  const backupEntries = await import("node:fs/promises").then((fs) => fs.readdir(tempRoot));
  assert.ok(backupEntries.some((entry) => entry.startsWith("registry.json.corrupt-")));
  assertEvent(events, "registry.read_corrupt", "warn");
});
