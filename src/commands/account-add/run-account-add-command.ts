import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../logging/logger.js";
import type { AppContext } from "../../core/context.js";
import { createAccountRegistry } from "../../accounts/account-registry.js";
import {
  createRuntimeContract,
  resolveAccountRuntimePaths,
} from "../../runtime/runtime-contract.js";
import {
  copyAccountScopedAuthArtifacts,
  prepareLoginWorkspace,
  type LoginWorkspace,
} from "../../runtime/login-workspace.js";
import {
  runInteractiveCodexLogin,
  type CodexLoginResult,
} from "../../process/run-codex-login.js";

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const ACCOUNT_METADATA_SCHEMA_VERSION = 1;

interface ParsedAccountAddArgs {
  label: string;
  timeoutMs: number;
}

interface AccountAuthMetadata {
  schemaVersion: number;
  accountId: string;
  label: string;
  capturedAt: string;
  authMode: string | null;
  authAccountId: string | null;
  lastRefresh: string | null;
  loginStatus: "succeeded";
}

export async function runAccountAddCommand(
  context: AppContext,
  argv: string[],
): Promise<number> {
  const logger = createLogger({
    level: context.logging.level,
    name: "account_add",
    sink: context.logging.sink,
  });
  if (argv.includes("--help")) {
    context.io.stdout.write(`${buildAccountAddHelpText()}\n`);
    logger.info("help.rendered");
    return 0;
  }
  const parsed = parseAccountAddArgs(argv);

  logger.info("command.start", {
    requestedLabel: parsed.label,
    timeoutMs: parsed.timeoutMs,
    codexBinaryPath: context.codexBinary.path,
    sharedCodexHome: context.paths.sharedCodexHome,
    accountRoot: context.paths.accountRoot,
    runtimeRoot: context.paths.runtimeRoot,
  });

  if (!context.codexBinary.path) {
    logger.error("command.binary_missing", {
      candidates: context.codexBinary.candidates,
      rejectedCandidates: context.codexBinary.rejectedCandidates,
    });
    throw new Error("Could not find the real `codex` binary on PATH.");
  }

  if (context.wrapperConfig.credentialStoreMode !== "file") {
    logger.error("command.unsupported_credential_store", {
      credentialStoreMode: context.wrapperConfig.credentialStoreMode,
      configFilePath: context.wrapperConfig.codexConfigFilePath,
      reason: context.wrapperConfig.credentialStorePolicyReason,
    });
    throw new Error(
      `codexes account add requires cli_auth_credentials_store = "file"; detected ${context.wrapperConfig.credentialStoreMode}.`,
    );
  }

  const registry = createAccountRegistry({
    accountRoot: context.paths.accountRoot,
    logger,
    registryFile: context.paths.registryFile,
  });
  const existingAccounts = await registry.listAccounts();
  const duplicate = existingAccounts.find(
    (account) => account.label.toLowerCase() === parsed.label.toLowerCase(),
  );

  if (duplicate) {
    logger.warn("command.duplicate_label", {
      requestedLabel: parsed.label,
      existingAccountId: duplicate.id,
    });
    throw new Error(`An account named "${parsed.label}" already exists.`);
  }

  const runtimeContract = createRuntimeContract({
    accountRoot: context.paths.accountRoot,
    credentialStoreMode: context.wrapperConfig.credentialStoreMode,
    logger,
    runtimeRoot: context.paths.runtimeRoot,
    sharedCodexHome: context.paths.sharedCodexHome,
  });
  const workspace = await prepareLoginWorkspace({
    logger,
    runtimeRoot: context.paths.runtimeRoot,
    sharedCodexHome: context.paths.sharedCodexHome,
  });

  let loginResult: CodexLoginResult | null = null;

  try {
    loginResult = await runInteractiveCodexLogin({
      codexBinaryPath: context.codexBinary.path,
      codexHome: workspace.codexHome,
      logger,
      timeoutMs: parsed.timeoutMs,
    });

    if (loginResult.exitCode !== 0) {
      logger.warn("command.login_failed", {
        exitCode: loginResult.exitCode,
        signal: loginResult.signal,
        timedOut: loginResult.timedOut,
        timeoutMs: loginResult.timeoutMs,
        cancelledBySignal: loginResult.cancelledBySignal,
      });
      context.io.stderr.write(buildLoginFailureMessage(loginResult));
      return loginResult.exitCode ?? 1;
    }

    const authSummary = await readAuthSummary(workspace.codexHome, logger);
    if (!authSummary.present) {
      logger.error("command.auth_missing_after_login", {
        codexHome: workspace.codexHome,
      });
      throw new Error(
        "codex login completed without creating auth.json in the isolated workspace.",
      );
    }

    const account = await registry.addAccount({ label: parsed.label });

    try {
      const runtimePaths = resolveAccountRuntimePaths(runtimeContract, account.id);
      await mkdir(runtimePaths.accountDirectory, { recursive: true });
      await copyAccountScopedAuthArtifacts({
        accountId: account.id,
        destinationRoot: runtimePaths.accountStateDirectory,
        logger,
        runtimeContract,
        sourceCodexHome: workspace.codexHome,
      });
      await writeAccountMetadata({
        capturedAt: new Date().toISOString(),
        destinationFile: runtimePaths.accountMetadataFile,
        label: account.label,
        logger,
        recordId: account.id,
        summary: authSummary,
      });

      logger.info("command.complete", {
        accountId: account.id,
        label: account.label,
        authDirectory: account.authDirectory,
        authAccountId: authSummary.accountId,
      });

      context.io.stdout.write(
        [
          `Added account "${account.label}"`,
          `  id: ${account.id}`,
          `  auth state: ${runtimePaths.accountStateDirectory}`,
          authSummary.accountId ? `  auth account id: ${authSummary.accountId}` : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n") + "\n",
      );

      return 0;
    } catch (error) {
      logger.error("command.persist_failed", {
        message: error instanceof Error ? error.message : String(error),
        accountLabel: parsed.label,
      });
      await cleanupFailedAccountRecord(registry, logger, parsed.label);
      throw error;
    }
  } finally {
    await cleanupWorkspace(workspace, logger, loginResult);
  }
}

function parseAccountAddArgs(argv: string[]): ParsedAccountAddArgs {
  let label: string | null = null;
  let timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    if (token === "--timeout-ms") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Expected a number after --timeout-ms.");
      }
      const parsedTimeout = Number.parseInt(next, 10);
      if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
        throw new Error(`Invalid timeout: ${next}`);
      }
      timeoutMs = parsedTimeout;
      index += 1;
      continue;
    }

    if (token.startsWith("--timeout-ms=")) {
      const raw = token.slice("--timeout-ms=".length);
      const parsedTimeout = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
        throw new Error(`Invalid timeout: ${raw}`);
      }
      timeoutMs = parsedTimeout;
      continue;
    }

    if (token.startsWith("--")) {
      throw new Error(`Unknown option for account add: ${token}`);
    }

    if (label) {
      throw new Error(`Unexpected argument for account add: ${token}`);
    }

    label = token.trim();
  }

  if (!label) {
    throw new Error(buildAccountAddHelpText());
  }

  return { label, timeoutMs };
}

function buildAccountAddHelpText(): string {
  return [
    "Usage:",
    "  codexes account add <label> [--timeout-ms <milliseconds>]",
    "",
    "Examples:",
    "  codexes account add work",
    "  codexes account add personal --timeout-ms 900000",
  ].join("\n");
}

async function readAuthSummary(
  codexHome: string,
  logger: ReturnType<typeof createLogger>,
): Promise<{
  present: boolean;
  authMode: string | null;
  accountId: string | null;
  lastRefresh: string | null;
}> {
  const authFile = path.join(codexHome, "auth.json");

  try {
    const raw = await readFile(authFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const tokens =
      typeof parsed.tokens === "object" && parsed.tokens !== null
        ? (parsed.tokens as Record<string, unknown>)
        : null;

    const summary = {
      present: true,
      authMode: typeof parsed.auth_mode === "string" ? parsed.auth_mode : null,
      accountId: typeof tokens?.account_id === "string" ? tokens.account_id : null,
      lastRefresh: typeof parsed.last_refresh === "string" ? parsed.last_refresh : null,
    };

    logger.debug("auth_summary.loaded", {
      authFile,
      authMode: summary.authMode,
      accountId: summary.accountId,
      lastRefresh: summary.lastRefresh,
    });

    return summary;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      logger.warn("auth_summary.missing", { authFile });
      return {
        present: false,
        authMode: null,
        accountId: null,
        lastRefresh: null,
      };
    }

    logger.error("auth_summary.failed", {
      authFile,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function writeAccountMetadata(input: {
  capturedAt: string;
  destinationFile: string;
  label: string;
  logger: ReturnType<typeof createLogger>;
  recordId: string;
  summary: {
    authMode: string | null;
    accountId: string | null;
    lastRefresh: string | null;
  };
}): Promise<void> {
  const metadata: AccountAuthMetadata = {
    schemaVersion: ACCOUNT_METADATA_SCHEMA_VERSION,
    accountId: input.recordId,
    label: input.label,
    capturedAt: input.capturedAt,
    authMode: input.summary.authMode,
    authAccountId: input.summary.accountId,
    lastRefresh: input.summary.lastRefresh,
    loginStatus: "succeeded",
  };

  await writeFile(input.destinationFile, JSON.stringify(metadata, null, 2), "utf8");

  input.logger.info("account_metadata.written", {
    destinationFile: input.destinationFile,
    accountId: metadata.accountId,
    authAccountId: metadata.authAccountId,
  });
}

async function cleanupFailedAccountRecord(
  registry: ReturnType<typeof createAccountRegistry>,
  logger: ReturnType<typeof createLogger>,
  label: string,
): Promise<void> {
  const accounts = await registry.listAccounts();
  const account = [...accounts]
    .reverse()
    .find((entry) => entry.label.toLowerCase() === label.toLowerCase());

  if (!account) {
    return;
  }

  await registry.removeAccount(account.id).catch(() => undefined);
  await rm(account.authDirectory, { force: true, recursive: true }).catch(() => undefined);

  logger.warn("command.rollback_account_record", {
    accountId: account.id,
    label: account.label,
  });
}

async function cleanupWorkspace(
  workspace: LoginWorkspace,
  logger: ReturnType<typeof createLogger>,
  loginResult: CodexLoginResult | null,
): Promise<void> {
  logger.debug("workspace.cleanup.start", {
    workspaceRoot: workspace.workspaceRoot,
    codexHome: workspace.codexHome,
    loginExitCode: loginResult?.exitCode ?? null,
  });

  await rm(workspace.workspaceRoot, {
    force: true,
    recursive: true,
  }).catch(() => undefined);

  logger.debug("workspace.cleanup.complete", {
    workspaceRoot: workspace.workspaceRoot,
  });
}

function buildLoginFailureMessage(loginResult: CodexLoginResult): string {
  if (loginResult.timedOut) {
    return `codexes: account login timed out after ${loginResult.timeoutMs}ms.\n`;
  }

  if (loginResult.cancelledBySignal) {
    return "codexes: account login was cancelled.\n";
  }

  return `codexes: account login failed with exit code ${loginResult.exitCode ?? "unknown"}.\n`;
}
