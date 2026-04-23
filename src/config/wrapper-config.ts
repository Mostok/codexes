import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logging/logger.js";
import type { ResolvedPaths } from "../core/paths.js";

export type CredentialStoreMode = "file" | "keyring" | "auto" | "missing" | "unknown";
export type AccountSelectionStrategy =
  | "manual-default"
  | "single-account"
  | "remaining-limit"
  | "remaining-limit-experimental";
export type RuntimeModel = "isolated-execution" | "legacy-shared";

export interface WrapperConfig {
  configFilePath: string;
  codexConfigFilePath: string;
  selectionCacheFilePath: string;
  credentialStoreMode: CredentialStoreMode;
  credentialStorePolicyReason: string;
  runtimeModel: RuntimeModel;
  runtimeModelSource: "default" | "env-override" | "invalid-env-fallback";
  accountSelectionStrategy: AccountSelectionStrategy;
  accountSelectionStrategySource: "default" | "env-override" | "invalid-env-fallback";
  experimentalSelection: ExperimentalSelectionConfig;
}

export interface ExperimentalSelectionConfig {
  enabled: boolean;
  probeTimeoutMs: number;
  cacheTtlMs: number;
  useAccountIdHeader: boolean;
}

export type CredentialStoreRepairResult =
  | {
      configFilePath: string;
      effectiveMode: "file";
      previousMode: CredentialStoreMode;
      repaired: boolean;
      status: "ready";
    }
  | {
      configFilePath: string;
      effectiveMode: CredentialStoreMode;
      previousMode: CredentialStoreMode;
      repaired: false;
      status: "unsupported";
    };

const DEFAULT_EXPERIMENTAL_PROBE_TIMEOUT_MS = 3_500;
const DEFAULT_EXPERIMENTAL_CACHE_TTL_MS = 60_000;
const CODEX_CONFIG_FILE_NAME = "config.toml";
const FILE_BACKED_CREDENTIAL_STORE_LINE = 'cli_auth_credentials_store = "file"';

export async function resolveWrapperConfig(input: {
  env: NodeJS.ProcessEnv;
  logger: Logger;
  paths: ResolvedPaths;
}): Promise<WrapperConfig> {
  await mkdir(input.paths.dataRoot, { recursive: true });

  const credentialStoreMode = await detectCredentialStoreMode(
    input.paths.codexConfigFile,
    input.logger,
  );

  const selectionStrategy = resolveAccountSelectionStrategy(input.env, input.logger);
  const runtimeModel = resolveRuntimeModel(input.env, input.logger);
  const resolved = {
    configFilePath: input.paths.wrapperConfigFile,
    codexConfigFilePath: input.paths.codexConfigFile,
    selectionCacheFilePath: input.paths.selectionCacheFile,
    credentialStoreMode,
    credentialStorePolicyReason:
      credentialStoreMode === "file"
        ? "file mode detected in Codex config"
        : "codexes currently supports only file-backed auth storage",
    runtimeModel: runtimeModel.model,
    runtimeModelSource: runtimeModel.source,
    accountSelectionStrategy: selectionStrategy.strategy,
    accountSelectionStrategySource: selectionStrategy.source,
    experimentalSelection: resolveExperimentalSelectionConfig({
      env: input.env,
      logger: input.logger,
      strategy: selectionStrategy.strategy,
    }),
  } satisfies WrapperConfig;

  input.logger.info("wrapper_config.resolved", {
    configFilePath: resolved.configFilePath,
    codexConfigFilePath: resolved.codexConfigFilePath,
    selectionCacheFilePath: resolved.selectionCacheFilePath,
    credentialStoreMode: resolved.credentialStoreMode,
    runtimeModel: resolved.runtimeModel,
    runtimeModelSource: resolved.runtimeModelSource,
    accountSelectionStrategy: resolved.accountSelectionStrategy,
    accountSelectionStrategySource: resolved.accountSelectionStrategySource,
    experimentalSelection: resolved.experimentalSelection,
  });

  return resolved;
}

function resolveRuntimeModel(
  env: NodeJS.ProcessEnv,
  logger: Logger,
): {
  model: RuntimeModel;
  source: "default" | "env-override" | "invalid-env-fallback";
} {
  const rawOverride = env.CODEXES_RUNTIME_MODEL?.trim().toLowerCase();

  switch (rawOverride) {
    case undefined:
    case "":
      logger.info("wrapper_config.runtime_model_default_applied", {
        runtimeModel: "isolated-execution",
      });
      return {
        model: "isolated-execution",
        source: "default",
      };
    case "isolated":
    case "isolated-execution":
      logger.info("wrapper_config.runtime_model_override_applied", {
        envKey: "CODEXES_RUNTIME_MODEL",
        requestedModel: rawOverride,
        runtimeModel: "isolated-execution",
      });
      return {
        model: "isolated-execution",
        source: "env-override",
      };
    case "legacy":
    case "legacy-shared":
      logger.warn("wrapper_config.runtime_model_legacy_enabled", {
        envKey: "CODEXES_RUNTIME_MODEL",
        requestedModel: rawOverride,
        runtimeModel: "legacy-shared",
      });
      return {
        model: "legacy-shared",
        source: "env-override",
      };
    default:
      logger.warn("wrapper_config.runtime_model_invalid_override", {
        envKey: "CODEXES_RUNTIME_MODEL",
        rawValue: rawOverride,
        fallbackModel: "isolated-execution",
      });
      return {
        model: "isolated-execution",
        source: "invalid-env-fallback",
      };
  }
}

function resolveExperimentalSelectionConfig(input: {
  env: NodeJS.ProcessEnv;
  logger: Logger;
  strategy: AccountSelectionStrategy;
}): ExperimentalSelectionConfig {
  const probeTimeoutMs = resolvePositiveIntegerEnv({
    defaultValue: DEFAULT_EXPERIMENTAL_PROBE_TIMEOUT_MS,
    env: input.env,
    envKey: "CODEXES_EXPERIMENTAL_SELECTION_TIMEOUT_MS",
    logger: input.logger,
  });
  const cacheTtlMs = resolvePositiveIntegerEnv({
    defaultValue: DEFAULT_EXPERIMENTAL_CACHE_TTL_MS,
    env: input.env,
    envKey: "CODEXES_EXPERIMENTAL_SELECTION_CACHE_TTL_MS",
    logger: input.logger,
  });
  const useAccountIdHeader = resolveBooleanEnv(
    input.env.CODEXES_EXPERIMENTAL_SELECTION_USE_ACCOUNT_ID_HEADER,
  );
  const enabled =
    input.strategy === "remaining-limit" ||
    input.strategy === "remaining-limit-experimental";

  input.logger.debug("wrapper_config.experimental_selection_resolved", {
    enabled,
    probeTimeoutMs,
    cacheTtlMs,
    useAccountIdHeader,
  });

  return {
    enabled,
    probeTimeoutMs,
    cacheTtlMs,
    useAccountIdHeader,
  };
}

export async function ensureFileBackedCredentialStore(input: {
  configFilePath: string;
  currentMode: CredentialStoreMode;
  logger: Logger;
}): Promise<CredentialStoreRepairResult> {
  input.logger.debug("credential_store.repair_check", {
    configFilePath: input.configFilePath,
    credentialStoreMode: input.currentMode,
  });

  if (input.currentMode === "file") {
    return {
      configFilePath: input.configFilePath,
      effectiveMode: "file",
      previousMode: input.currentMode,
      repaired: false,
      status: "ready",
    };
  }

  if (input.currentMode !== "missing") {
    input.logger.warn("credential_store.repair_unsupported", {
      configFilePath: input.configFilePath,
      credentialStoreMode: input.currentMode,
      supportedMode: "file",
    });

    return {
      configFilePath: input.configFilePath,
      effectiveMode: input.currentMode,
      previousMode: input.currentMode,
      repaired: false,
      status: "unsupported",
    };
  }

  try {
    const writableConfigFilePath = await validateWritableCodexConfigPath(
      input.configFilePath,
      input.logger,
    );
    await mkdir(path.dirname(writableConfigFilePath), { recursive: true });

    const existingConfig = await readFile(writableConfigFilePath, "utf8").catch(
      (error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return null;
        }

        throw error;
      },
    );

    const nextConfig =
      existingConfig === null || existingConfig.length === 0
        ? `${FILE_BACKED_CREDENTIAL_STORE_LINE}\n`
        : insertTopLevelTomlLine(existingConfig, FILE_BACKED_CREDENTIAL_STORE_LINE);

    await writeFile(writableConfigFilePath, nextConfig, "utf8");

    input.logger.info(
      existingConfig === null
        ? "credential_store.config_created"
        : "credential_store.config_repaired",
      {
        configFilePath: writableConfigFilePath,
        previousMode: input.currentMode,
        effectiveMode: "file",
      },
    );

    return {
      configFilePath: writableConfigFilePath,
      effectiveMode: "file",
      previousMode: input.currentMode,
      repaired: true,
      status: "ready",
    };
  } catch (error) {
    input.logger.error("credential_store.repair_failed", {
      configFilePath: input.configFilePath,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function validateWritableCodexConfigPath(
  configFilePath: string,
  logger: Logger,
): Promise<string> {
  const resolvedDirectoryPath = path.resolve(path.dirname(configFilePath));
  const resolvedConfigFilePath = path.resolve(configFilePath);
  const expectedConfigFilePath = path.join(resolvedDirectoryPath, CODEX_CONFIG_FILE_NAME);

  if (path.basename(resolvedConfigFilePath) !== CODEX_CONFIG_FILE_NAME) {
    logger.error("credential_store.invalid_config_target", {
      configFilePath,
      expectedFileName: CODEX_CONFIG_FILE_NAME,
    });
    throw new Error("Unsafe Codex config target.");
  }

  if (resolvedConfigFilePath !== expectedConfigFilePath) {
    logger.error("credential_store.invalid_config_target", {
      configFilePath,
      expectedConfigFilePath,
      resolvedConfigFilePath,
    });
    throw new Error("Unsafe Codex config target.");
  }

  const existingAncestorPath = await findNearestExistingPath(resolvedDirectoryPath);
  await ensurePathDoesNotUseSymlink(existingAncestorPath, logger);

  const relativeSuffix = path.relative(existingAncestorPath, resolvedDirectoryPath);
  let currentPath = await realpath(existingAncestorPath);
  if (relativeSuffix !== "") {
    for (const segment of relativeSuffix.split(path.sep)) {
      currentPath = path.join(currentPath, segment);
      await ensurePathDoesNotUseSymlink(currentPath, logger, { allowMissing: true });
    }
  }

  await ensurePathDoesNotUseSymlink(resolvedConfigFilePath, logger, { allowMissing: true });
  return resolvedConfigFilePath;
}

async function findNearestExistingPath(targetPath: string): Promise<string> {
  let currentPath = targetPath;

  while (true) {
    const stats = await lstat(currentPath).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }

      throw error;
    });

    if (stats) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return currentPath;
    }
    currentPath = parentPath;
  }
}

async function ensurePathDoesNotUseSymlink(
  targetPath: string,
  logger: Logger,
  options?: { allowMissing?: boolean },
): Promise<void> {
  const stats = await lstat(targetPath).catch((error: unknown) => {
    if (
      options?.allowMissing &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  });

  if (stats?.isSymbolicLink()) {
    logger.error("credential_store.symlink_blocked", {
      configPath: targetPath,
    });
    throw new Error("Unsafe Codex config target.");
  }
}

function insertTopLevelTomlLine(rawConfig: string, line: string): string {
  const eol = rawConfig.includes("\r\n") ? "\r\n" : "\n";
  const firstSectionMatch = /^[\t ]*\[/m.exec(rawConfig);

  if (!firstSectionMatch || firstSectionMatch.index === undefined) {
    return `${rawConfig}${rawConfig.endsWith("\n") ? "" : eol}${line}${eol}`;
  }

  const topLevelPrefix = rawConfig.slice(0, firstSectionMatch.index);
  const remainingConfig = rawConfig.slice(firstSectionMatch.index);
  const separator = topLevelPrefix.length > 0 && !topLevelPrefix.endsWith("\n") ? eol : "";

  return `${topLevelPrefix}${separator}${line}${eol}${remainingConfig}`;
}

function resolveAccountSelectionStrategy(
  env: NodeJS.ProcessEnv,
  logger: Logger,
): {
  source: "default" | "env-override" | "invalid-env-fallback";
  strategy: AccountSelectionStrategy;
} {
  const rawOverride = env.CODEXES_ACCOUNT_SELECTION_STRATEGY?.trim().toLowerCase();

  switch (rawOverride) {
    case "single-account":
      logger.info("wrapper_config.selection_strategy_override_applied", {
        envKey: "CODEXES_ACCOUNT_SELECTION_STRATEGY",
        requestedStrategy: rawOverride,
        resolvedStrategy: "single-account",
      });
      return {
        source: "env-override",
        strategy: "single-account",
      };
    case "remaining-limit":
    case "remaining-limit-experimental":
      logger.info("wrapper_config.selection_strategy_override_applied", {
        envKey: "CODEXES_ACCOUNT_SELECTION_STRATEGY",
        requestedStrategy: rawOverride,
        resolvedStrategy: "remaining-limit",
      });
      return {
        source: "env-override",
        strategy: "remaining-limit",
      };
    case undefined:
    case "":
      logger.info("wrapper_config.selection_strategy_default_applied", {
        defaultStrategy: "remaining-limit",
      });
      return {
        source: "default",
        strategy: "remaining-limit",
      };
    case "manual-default":
      logger.info("wrapper_config.selection_strategy_override_applied", {
        envKey: "CODEXES_ACCOUNT_SELECTION_STRATEGY",
        requestedStrategy: rawOverride,
        resolvedStrategy: "manual-default",
      });
      return {
        source: "env-override",
        strategy: "manual-default",
      };
    default:
      logger.warn("wrapper_config.selection_strategy_invalid_override", {
        envKey: "CODEXES_ACCOUNT_SELECTION_STRATEGY",
        rawValue: rawOverride,
        fallbackStrategy: "remaining-limit",
      });
      return {
        source: "invalid-env-fallback",
        strategy: "remaining-limit",
      };
  }
}

async function detectCredentialStoreMode(
  configFile: string,
  logger: Logger,
): Promise<CredentialStoreMode> {
  try {
    const rawConfig = await readFile(configFile, "utf8");
    const mode = parseCredentialStoreMode(rawConfig);

    logger.debug("credential_store.detected", {
      configFile,
      credentialStoreMode: mode,
    });

    return mode;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      logger.warn("credential_store.config_missing", {
        configFile,
        fallbackMode: "missing",
      });
      return "missing";
    }

    logger.error("credential_store.read_failed", {
      configFile,
      message: error instanceof Error ? error.message : String(error),
    });

    return "unknown";
  }
}

function parseCredentialStoreMode(rawConfig: string): CredentialStoreMode {
  const topLevelConfig = extractTopLevelTomlConfig(rawConfig);
  const match = topLevelConfig.match(/^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"/m);

  if (!match) {
    return "missing";
  }

  const configuredValue = match[1];

  if (!configuredValue) {
    return "unknown";
  }

  switch (configuredValue.trim().toLowerCase()) {
    case "file":
      return "file";
    case "keyring":
      return "keyring";
    case "auto":
      return "auto";
    default:
      return "unknown";
  }
}

function extractTopLevelTomlConfig(rawConfig: string): string {
  const firstSectionMatch = /^[\t ]*\[/m.exec(rawConfig);

  if (!firstSectionMatch || firstSectionMatch.index === undefined) {
    return rawConfig;
  }

  return rawConfig.slice(0, firstSectionMatch.index);
}

function resolvePositiveIntegerEnv(input: {
  defaultValue: number;
  env: NodeJS.ProcessEnv;
  envKey: string;
  logger: Logger;
}): number {
  const raw = input.env[input.envKey]?.trim();
  if (!raw) {
    return input.defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    input.logger.warn("wrapper_config.invalid_env_override", {
      envKey: input.envKey,
      rawValue: raw,
      fallbackValue: input.defaultValue,
    });
    return input.defaultValue;
  }

  return parsed;
}

function resolveBooleanEnv(value: string | undefined): boolean {
  switch (value?.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}
