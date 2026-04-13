import { mkdir, readFile } from "node:fs/promises";
import type { Logger } from "../logging/logger.js";
import type { ResolvedPaths } from "../core/paths.js";

export type CredentialStoreMode = "file" | "keyring" | "auto" | "missing" | "unknown";
export type AccountSelectionStrategy =
  | "manual-default"
  | "single-account"
  | "remaining-limit-experimental";

export interface WrapperConfig {
  configFilePath: string;
  codexConfigFilePath: string;
  selectionCacheFilePath: string;
  credentialStoreMode: CredentialStoreMode;
  credentialStorePolicyReason: string;
  accountSelectionStrategy: AccountSelectionStrategy;
  experimentalSelection: ExperimentalSelectionConfig;
}

export interface ExperimentalSelectionConfig {
  enabled: boolean;
  probeTimeoutMs: number;
  cacheTtlMs: number;
  useAccountIdHeader: boolean;
}

const DEFAULT_EXPERIMENTAL_PROBE_TIMEOUT_MS = 3_500;
const DEFAULT_EXPERIMENTAL_CACHE_TTL_MS = 60_000;

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

  const resolved = {
    configFilePath: input.paths.wrapperConfigFile,
    codexConfigFilePath: input.paths.codexConfigFile,
    selectionCacheFilePath: input.paths.selectionCacheFile,
    credentialStoreMode,
    credentialStorePolicyReason:
      credentialStoreMode === "file"
        ? "file mode detected in Codex config"
        : "codexes currently supports only file-backed auth storage",
    accountSelectionStrategy: resolveAccountSelectionStrategy(input.env),
    experimentalSelection: resolveExperimentalSelectionConfig(input.env, input.logger),
  } satisfies WrapperConfig;

  input.logger.info("wrapper_config.resolved", {
    configFilePath: resolved.configFilePath,
    codexConfigFilePath: resolved.codexConfigFilePath,
    selectionCacheFilePath: resolved.selectionCacheFilePath,
    credentialStoreMode: resolved.credentialStoreMode,
    accountSelectionStrategy: resolved.accountSelectionStrategy,
    experimentalSelection: resolved.experimentalSelection,
  });

  return resolved;
}

function resolveExperimentalSelectionConfig(
  env: NodeJS.ProcessEnv,
  logger: Logger,
): ExperimentalSelectionConfig {
  const probeTimeoutMs = resolvePositiveIntegerEnv({
    defaultValue: DEFAULT_EXPERIMENTAL_PROBE_TIMEOUT_MS,
    env,
    envKey: "CODEXES_EXPERIMENTAL_SELECTION_TIMEOUT_MS",
    logger,
  });
  const cacheTtlMs = resolvePositiveIntegerEnv({
    defaultValue: DEFAULT_EXPERIMENTAL_CACHE_TTL_MS,
    env,
    envKey: "CODEXES_EXPERIMENTAL_SELECTION_CACHE_TTL_MS",
    logger,
  });
  const useAccountIdHeader = resolveBooleanEnv(
    env.CODEXES_EXPERIMENTAL_SELECTION_USE_ACCOUNT_ID_HEADER,
  );
  const enabled =
    resolveAccountSelectionStrategy(env) === "remaining-limit-experimental";

  logger.debug("wrapper_config.experimental_selection_resolved", {
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

function resolveAccountSelectionStrategy(
  env: NodeJS.ProcessEnv,
): AccountSelectionStrategy {
  switch (env.CODEXES_ACCOUNT_SELECTION_STRATEGY?.trim().toLowerCase()) {
    case "single-account":
      return "single-account";
    case "remaining-limit-experimental":
      return "remaining-limit-experimental";
    case "manual-default":
    case undefined:
    case "":
      return "manual-default";
    default:
      return "manual-default";
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
  const match = rawConfig.match(/^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"/m);

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
