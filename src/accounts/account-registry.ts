import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logging/logger.js";

const REGISTRY_SCHEMA_VERSION = 1;

export interface AccountRecord {
  id: string;
  label: string;
  authDirectory: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface AccountRegistryDocument {
  schemaVersion: number;
  defaultAccountId: string | null;
  accounts: AccountRecord[];
}

export interface AccountRegistry {
  addAccount(input: { label: string; authDirectory?: string }): Promise<AccountRecord>;
  getDefaultAccount(): Promise<AccountRecord | null>;
  listAccounts(): Promise<AccountRecord[]>;
  renameAccount(accountId: string, label: string): Promise<AccountRecord>;
  removeAccount(accountId: string): Promise<AccountRecord>;
  selectAccount(accountId: string): Promise<AccountRecord>;
}

export function createAccountRegistry(input: {
  accountRoot: string;
  logger: Logger;
  registryFile: string;
}): AccountRegistry {
  return {
    addAccount(details) {
      return withRegistryMutation(input, "registry.add", async (document, now) => {
        const normalizedLabel = normalizeLabel(details.label);
        const duplicate = document.accounts.find(
          (account) => account.label.toLowerCase() === normalizedLabel.toLowerCase(),
        );

        if (duplicate) {
          input.logger.warn("registry.duplicate_label", {
            label: normalizedLabel,
            existingAccountId: duplicate.id,
          });
          throw new Error(`An account named "${normalizedLabel}" already exists.`);
        }

        const accountId = randomUUID();
        const record: AccountRecord = {
          id: accountId,
          label: normalizedLabel,
          authDirectory: details.authDirectory ?? path.join(input.accountRoot, accountId),
          createdAt: now,
          updatedAt: now,
          lastUsedAt: null,
        };

        document.accounts.push(record);
        if (!document.defaultAccountId) {
          document.defaultAccountId = record.id;
        }

        input.logger.info("registry.account_added", {
          accountId: record.id,
          label: record.label,
          authDirectory: record.authDirectory,
          defaultAccountId: document.defaultAccountId,
        });

        return record;
      });
    },
    async getDefaultAccount() {
      const document = await readRegistryDocument(input);
      const account = document.defaultAccountId
        ? document.accounts.find((entry) => entry.id === document.defaultAccountId) ?? null
        : null;

      input.logger.debug("registry.default_loaded", {
        defaultAccountId: document.defaultAccountId,
        resolvedAccountId: account?.id ?? null,
      });

      return account;
    },
    async listAccounts() {
      const document = await readRegistryDocument(input);

      input.logger.debug("registry.list_loaded", {
        accountCount: document.accounts.length,
        defaultAccountId: document.defaultAccountId,
      });

      return [...document.accounts];
    },
    renameAccount(accountId, label) {
      return withRegistryMutation(input, "registry.rename", async (document, now) => {
        const record = document.accounts.find((account) => account.id === accountId);

        if (!record) {
          input.logger.warn("registry.rename_missing", { accountId });
          throw new Error(`Account "${accountId}" was not found.`);
        }

        const normalizedLabel = normalizeLabel(label);
        const duplicate = document.accounts.find(
          (account) =>
            account.id !== accountId &&
            account.label.toLowerCase() === normalizedLabel.toLowerCase(),
        );

        if (duplicate) {
          input.logger.warn("registry.rename_duplicate_label", {
            accountId,
            label: normalizedLabel,
            existingAccountId: duplicate.id,
          });
          throw new Error(`An account named "${normalizedLabel}" already exists.`);
        }

        const previousLabel = record.label;
        record.label = normalizedLabel;
        record.updatedAt = now;

        input.logger.info("registry.account_renamed", {
          accountId,
          previousLabel,
          label: record.label,
        });

        return record;
      });
    },
    removeAccount(accountId) {
      return withRegistryMutation(input, "registry.remove", async (document, now) => {
        const record = document.accounts.find((account) => account.id === accountId);

        if (!record) {
          input.logger.warn("registry.remove_missing", { accountId });
          throw new Error(`Account "${accountId}" was not found.`);
        }

        document.accounts = document.accounts.filter((account) => account.id !== accountId);
        if (document.defaultAccountId === accountId) {
          document.defaultAccountId = document.accounts[0]?.id ?? null;
        }

        record.updatedAt = now;

        input.logger.info("registry.account_removed", {
          accountId,
          nextDefaultAccountId: document.defaultAccountId,
        });

        return record;
      });
    },
    selectAccount(accountId) {
      return withRegistryMutation(input, "registry.select", async (document, now) => {
        const record = document.accounts.find((account) => account.id === accountId);

        if (!record) {
          input.logger.warn("registry.select_missing", { accountId });
          throw new Error(`Account "${accountId}" was not found.`);
        }

        document.defaultAccountId = record.id;
        record.updatedAt = now;
        record.lastUsedAt = now;

        input.logger.info("registry.account_selected", {
          accountId,
          label: record.label,
        });

        return record;
      });
    },
  };
}

async function withRegistryMutation<T>(
  input: {
    accountRoot: string;
    logger: Logger;
    registryFile: string;
  },
  operation: string,
  mutate: (document: AccountRegistryDocument, now: string) => Promise<T> | T,
): Promise<T> {
  await mkdir(input.accountRoot, { recursive: true });
  await mkdir(path.dirname(input.registryFile), { recursive: true });

  const document = await readRegistryDocument(input);
  const now = new Date().toISOString();

  input.logger.debug(`${operation}.start`, {
    registryFile: input.registryFile,
    accountRoot: input.accountRoot,
    accountCount: document.accounts.length,
  });

  const result = await mutate(document, now);

  await persistRegistryDocument(input, document);

  input.logger.debug(`${operation}.complete`, {
    registryFile: input.registryFile,
    accountCount: document.accounts.length,
    defaultAccountId: document.defaultAccountId,
  });

  return result;
}

async function readRegistryDocument(input: {
  accountRoot: string;
  logger: Logger;
  registryFile: string;
}): Promise<AccountRegistryDocument> {
  await mkdir(input.accountRoot, { recursive: true });
  await mkdir(path.dirname(input.registryFile), { recursive: true });

  try {
    const raw = await readFile(input.registryFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const migrated = migrateRegistryDocument(parsed, input.logger, input.registryFile);

    input.logger.debug("registry.read_success", {
      registryFile: input.registryFile,
      schemaVersion: migrated.schemaVersion,
      accountCount: migrated.accounts.length,
    });

    return migrated;
  } catch (error) {
    if (isFileMissing(error)) {
      const emptyDocument = createEmptyRegistryDocument();
      input.logger.info("registry.read_missing", {
        registryFile: input.registryFile,
        action: "create_empty_registry",
      });
      await persistRegistryDocument(input, emptyDocument);
      return emptyDocument;
    }

    const normalized = normalizeUnknownError(error);
    const corruptionBackupPath = `${input.registryFile}.corrupt-${Date.now()}`;

    input.logger.warn("registry.read_corrupt", {
      registryFile: input.registryFile,
      corruptionBackupPath,
      message: normalized.message,
    });

    await rename(input.registryFile, corruptionBackupPath).catch(() => undefined);

    const emptyDocument = createEmptyRegistryDocument();
    await persistRegistryDocument(input, emptyDocument);

    return emptyDocument;
  }
}

async function persistRegistryDocument(
  input: {
    logger: Logger;
    registryFile: string;
  },
  document: AccountRegistryDocument,
): Promise<void> {
  const tempFile = `${input.registryFile}.tmp`;
  const serialized = JSON.stringify(document, null, 2);

  await writeFile(tempFile, serialized, "utf8");
  await rename(tempFile, input.registryFile);

  input.logger.debug("registry.write_success", {
    registryFile: input.registryFile,
    bytes: Buffer.byteLength(serialized, "utf8"),
    schemaVersion: document.schemaVersion,
    defaultAccountId: document.defaultAccountId,
  });
}

function migrateRegistryDocument(
  value: unknown,
  logger: Logger,
  registryFile: string,
): AccountRegistryDocument {
  if (!isObject(value)) {
    throw new Error("Registry document is not a JSON object.");
  }

  const schemaVersion = typeof value.schemaVersion === "number" ? value.schemaVersion : 0;

  logger.debug("registry.migration_check", {
    registryFile,
    schemaVersion,
    targetSchemaVersion: REGISTRY_SCHEMA_VERSION,
  });

  if (schemaVersion > REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `Registry schema ${schemaVersion} is newer than supported schema ${REGISTRY_SCHEMA_VERSION}.`,
    );
  }

  if (schemaVersion === REGISTRY_SCHEMA_VERSION) {
    return normalizeRegistryDocument(value);
  }

  if (schemaVersion === 0) {
    const migrated = normalizeRegistryDocument({
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      defaultAccountId: value.defaultAccountId ?? null,
      accounts: value.accounts ?? [],
    });

    logger.info("registry.migration_applied", {
      registryFile,
      fromSchemaVersion: 0,
      toSchemaVersion: REGISTRY_SCHEMA_VERSION,
    });

    return migrated;
  }

  throw new Error(`Unsupported registry schema version ${schemaVersion}.`);
}

function normalizeRegistryDocument(value: Record<string, unknown>): AccountRegistryDocument {
  const accounts = Array.isArray(value.accounts)
    ? value.accounts.map(normalizeAccountRecord)
    : [];
  const defaultAccountId = typeof value.defaultAccountId === "string"
    ? value.defaultAccountId
    : null;

  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    defaultAccountId:
      defaultAccountId && accounts.some((account) => account.id === defaultAccountId)
        ? defaultAccountId
        : accounts[0]?.id ?? null,
    accounts,
  };
}

function normalizeAccountRecord(value: unknown): AccountRecord {
  if (!isObject(value)) {
    throw new Error("Account record is not an object.");
  }

  const id = typeof value.id === "string" ? value.id : randomUUID();
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;

  return {
    id,
    label: normalizeLabel(typeof value.label === "string" ? value.label : id),
    authDirectory:
      typeof value.authDirectory === "string" ? value.authDirectory : path.join("accounts", id),
    createdAt,
    updatedAt,
    lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : null,
  };
}

function createEmptyRegistryDocument(): AccountRegistryDocument {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    defaultAccountId: null,
    accounts: [],
  };
}

function normalizeLabel(label: string): string {
  const normalized = label.trim();

  if (!normalized) {
    throw new Error("Account label cannot be empty.");
  }

  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFileMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function normalizeUnknownError(error: unknown): { message: string } {
  if (error instanceof Error) {
    return { message: error.message };
  }

  return { message: String(error) };
}

export async function deleteRegistryFile(registryFile: string): Promise<void> {
  const fileStats = await stat(registryFile).catch(() => null);

  if (!fileStats) {
    return;
  }

  await rm(registryFile, { force: true });
}
