import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  copyFile,
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createLogger, createLogSink, type Logger } from "../logging/logger.js";

interface ProbeEnvironment {
  codexBinary: string;
  sourceCodexHome: string;
  workingRoot: string;
}

interface ProbeScenarioDefinition {
  key: string;
  description: string;
  setupMode: "clone-home" | "auth-only";
}

interface ProbeScenarioResult {
  key: string;
  description: string;
  commandExitCode: number | null;
  commandOutput: string;
  commandSucceeded: boolean;
  beforeFiles: FileFingerprint[];
  afterFiles: FileFingerprint[];
  changedFiles: FileDelta[];
  createdFiles: FileDelta[];
  removedFiles: FileDelta[];
}

interface FileFingerprint {
  relativePath: string;
  size: number;
  modifiedMs: number;
  sha256: string;
}

interface FileDelta {
  relativePath: string;
  before?: FileFingerprint;
  after?: FileFingerprint;
}

interface AuthStateProbeReport {
  platform: NodeJS.Platform;
  sourceCodexHome: string;
  codexBinary: string;
  credentialStore: {
    explicitMode: string;
    inferredFromArtifacts: string;
  };
  sourceLayout: SourceLayoutSummary;
  scenarios: ProbeScenarioResult[];
  conclusion: {
    authJsonAloneSufficient: boolean;
    requiresSqliteIsolation: boolean;
    recommendedAccountScopedPatterns: string[];
    recommendedSharedPatterns: string[];
    recommendedEphemeralPatterns: string[];
    recommendedProtectedPatterns: string[];
    rationale: string[];
    posixAssumption: string;
  };
}

interface ConsoleProbeSummary {
  outputPath: string;
  platform: NodeJS.Platform;
  sourceCodexHome: string;
  codexBinary: string;
  explicitCredentialStore: string;
  inferredCredentialStore: string;
  authJsonAloneSufficient: boolean;
  requiresSqliteIsolation: boolean;
  scenarios: Array<{
    key: string;
    exitCode: number | null;
    commandSucceeded: boolean;
    changedFiles: string[];
    createdFiles: string[];
    removedFiles: string[];
  }>;
}

interface SourceLayoutSummary {
  topLevelEntries: string[];
  authJsonPresent: boolean;
  sessionFileCount: number;
  sqliteFiles: string[];
}

const PROBE_SCENARIOS: ProbeScenarioDefinition[] = [
  {
    key: "full-home-login-status",
    description: "Clone the current Codex home and run `codex login status`.",
    setupMode: "clone-home",
  },
  {
    key: "auth-only-login-status",
    description: "Run `codex login status` with only `auth.json` and `config.toml` copied into a clean home.",
    setupMode: "auth-only",
  },
];

export async function runAuthStateProbe(input: ProbeEnvironment): Promise<AuthStateProbeReport> {
  const logger = createLogger({
    level: process.env.LOG_LEVEL ?? "DEBUG",
    name: "auth_probe",
    sink: createLogSink(process.stderr),
  });

  logger.info("probe.start", {
    codexBinary: input.codexBinary,
    sourceCodexHome: input.sourceCodexHome,
    workingRoot: input.workingRoot,
    platform: process.platform,
  });

  const sourceLayout = await summarizeSourceLayout(input.sourceCodexHome, logger);
  const explicitCredentialStore = await readExplicitCredentialStore(input.sourceCodexHome, logger);
  const inferredCredentialStore = inferCredentialStoreFromLayout(sourceLayout);
  const scenarioResults: ProbeScenarioResult[] = [];

  for (const scenario of PROBE_SCENARIOS) {
    scenarioResults.push(await runScenario(scenario, input, logger));
  }

  const fullHomeScenario = scenarioResults.find((entry) => entry.key === "full-home-login-status");
  const authOnlyScenario = scenarioResults.find((entry) => entry.key === "auth-only-login-status");
  const requiresSqliteIsolation =
    Boolean(fullHomeScenario?.changedFiles.some((entry) => /(^|\/)(state_|logs_).+\.sqlite/i.test(entry.relativePath))) ||
    !Boolean(authOnlyScenario?.commandSucceeded);

  const report: AuthStateProbeReport = {
    platform: process.platform,
    sourceCodexHome: input.sourceCodexHome,
    codexBinary: input.codexBinary,
    credentialStore: {
      explicitMode: explicitCredentialStore,
      inferredFromArtifacts: inferredCredentialStore,
    },
    sourceLayout,
    scenarios: scenarioResults,
    conclusion: {
      authJsonAloneSufficient: Boolean(authOnlyScenario?.commandSucceeded),
      requiresSqliteIsolation,
      recommendedAccountScopedPatterns: ["auth.json", "sessions/**"],
      recommendedSharedPatterns: ["config.toml", "mcp.json", "trust/**"],
      recommendedEphemeralPatterns: ["cache/**", "logs/**", "tmp/**", "history.jsonl"],
      recommendedProtectedPatterns: ["state_*.sqlite*", "logs_*.sqlite*", "keyring/**"],
      rationale: buildRationale({
        authOnlyScenario,
        explicitCredentialStore,
        fullHomeScenario,
        inferredCredentialStore,
      }),
      posixAssumption:
        "POSIX installations are likely to expose the same auth-vs-state split because the Codex CLI is Node-based and the observed file names are platform-neutral, but the absolute data root and file-locking behavior still need a native POSIX probe before relying on it in production.",
    },
  };

  logger.info("probe.complete", {
    authJsonAloneSufficient: report.conclusion.authJsonAloneSufficient,
    requiresSqliteIsolation: report.conclusion.requiresSqliteIsolation,
    explicitCredentialStore: report.credentialStore.explicitMode,
    inferredCredentialStore: report.credentialStore.inferredFromArtifacts,
  });

  return report;
}

async function runScenario(
  scenario: ProbeScenarioDefinition,
  environment: ProbeEnvironment,
  logger: Logger,
): Promise<ProbeScenarioResult> {
  const scenarioRoot = await mkdtemp(path.join(environment.workingRoot, `${scenario.key}-`));

  logger.info("scenario.start", {
    scenario: scenario.key,
    description: scenario.description,
    scenarioRoot,
  });

  try {
    await prepareScenarioHome(scenario, environment.sourceCodexHome, scenarioRoot, logger);
    const beforeFiles = await snapshotFiles(scenarioRoot, logger);
    const commandResult = await runCodexLoginStatus(environment.codexBinary, scenarioRoot, logger, scenario.key);
    const afterFiles = await snapshotFiles(scenarioRoot, logger);
    const delta = diffSnapshots(beforeFiles, afterFiles);

    logger.info("scenario.complete", {
      scenario: scenario.key,
      exitCode: commandResult.exitCode,
      changedFiles: delta.changedFiles.map((entry) => entry.relativePath),
      createdFiles: delta.createdFiles.map((entry) => entry.relativePath),
      removedFiles: delta.removedFiles.map((entry) => entry.relativePath),
    });

    return {
      key: scenario.key,
      description: scenario.description,
      commandExitCode: commandResult.exitCode,
      commandOutput: commandResult.output,
      commandSucceeded: commandResult.exitCode === 0,
      beforeFiles,
      afterFiles,
      changedFiles: delta.changedFiles,
      createdFiles: delta.createdFiles,
      removedFiles: delta.removedFiles,
    };
  } finally {
    logger.debug("scenario.cleanup", {
      scenario: scenario.key,
      scenarioRoot,
    });
    await rm(scenarioRoot, { force: true, recursive: true });
  }
}

async function prepareScenarioHome(
  scenario: ProbeScenarioDefinition,
  sourceCodexHome: string,
  destinationHome: string,
  logger: Logger,
): Promise<void> {
  await rm(destinationHome, { force: true, recursive: true });
  await mkdir(destinationHome, { recursive: true });

  if (scenario.setupMode === "clone-home") {
    logger.debug("scenario.setup.clone_home", {
      sourceCodexHome,
      destinationHome,
    });
    await cp(sourceCodexHome, destinationHome, { recursive: true });
    return;
  }

  logger.debug("scenario.setup.auth_only", {
    sourceCodexHome,
    destinationHome,
  });

  const filesToCopy = ["auth.json", "config.toml"];

  for (const relativePath of filesToCopy) {
    const sourceFile = path.join(sourceCodexHome, relativePath);
    const destinationFile = path.join(destinationHome, relativePath);
    try {
      await copyFile(sourceFile, destinationFile);
      logger.debug("scenario.setup.file_copied", {
        scenario: scenario.key,
        relativePath,
      });
    } catch (error) {
      logger.warn("scenario.setup.file_missing", {
        scenario: scenario.key,
        relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Keep the auth-only scenario minimal but valid enough for the CLI to start.
  await mkdir(path.join(destinationHome, "sessions"), { recursive: true });
}

async function runCodexLoginStatus(
  codexBinary: string,
  codexHome: string,
  logger: Logger,
  scenarioKey: string,
): Promise<{ exitCode: number | null; output: string }> {
  logger.info("codex.command.start", {
    scenario: scenarioKey,
    codexBinary,
    codexHome,
    argv: ["login", "status"],
  });

  return new Promise((resolve, reject) => {
    const child = spawn(codexBinary, ["login", "status"], {
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("error", (error) => {
      logger.error("codex.command.failed_to_spawn", {
        scenario: scenarioKey,
        codexBinary,
        message: error.message,
      });
      reject(error);
    });

    child.on("exit", (exitCode, signal) => {
      logger.info("codex.command.complete", {
        scenario: scenarioKey,
        exitCode,
        signal,
        outputPreview: output.trim().slice(0, 200),
      });
      resolve({ exitCode, output: output.trim() });
    });
  });
}

async function summarizeSourceLayout(
  sourceCodexHome: string,
  logger: Logger,
): Promise<SourceLayoutSummary> {
  logger.debug("source_layout.scan.start", { sourceCodexHome });
  const topLevelEntries = (await readdir(sourceCodexHome, { withFileTypes: true }))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const sessionFiles = await collectFiles(path.join(sourceCodexHome, "sessions"));
  const sqliteFiles = topLevelEntries.filter((entry) => /\.sqlite(?:-wal|-shm)?$/i.test(entry));

  const summary: SourceLayoutSummary = {
    topLevelEntries,
    authJsonPresent: topLevelEntries.includes("auth.json"),
    sessionFileCount: sessionFiles.length,
    sqliteFiles,
  };

  logger.debug("source_layout.scan.complete", {
    topLevelEntries: summary.topLevelEntries,
    authJsonPresent: summary.authJsonPresent,
    sessionFileCount: summary.sessionFileCount,
    sqliteFiles: summary.sqliteFiles,
  });
  return summary;
}

async function readExplicitCredentialStore(
  sourceCodexHome: string,
  logger: Logger,
): Promise<string> {
  const configPath = path.join(sourceCodexHome, "config.toml");

  try {
    const rawConfig = await readFile(configPath, "utf8");
    const match = rawConfig.match(/^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"/m);
    const mode = match?.[1] ?? "missing";

    logger.debug("credential_store.explicit_mode", {
      configPath,
      mode,
    });

    return mode;
  } catch (error) {
    logger.warn("credential_store.explicit_mode_failed", {
      configPath,
      message: error instanceof Error ? error.message : String(error),
    });

    return "missing";
  }
}

function inferCredentialStoreFromLayout(summary: SourceLayoutSummary): string {
  if (summary.authJsonPresent) {
    return "file-artifacts-present";
  }

  return "file-artifacts-missing";
}

async function snapshotFiles(root: string, logger: Logger): Promise<FileFingerprint[]> {
  logger.debug("snapshot.start", { root });
  const filePaths = await collectFiles(root);
  const fingerprints: FileFingerprint[] = [];

  for (const filePath of filePaths) {
    const fileStat = await stat(filePath);
    const fileContent = await readFile(filePath);
    const relativePath = toPosixPath(path.relative(root, filePath));
    fingerprints.push({
      relativePath,
      size: fileStat.size,
      modifiedMs: fileStat.mtimeMs,
      sha256: createHash("sha256").update(fileContent).digest("hex"),
    });
  }

  fingerprints.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  logger.debug("snapshot.complete", {
    root,
    fileCount: fingerprints.length,
  });
  return fingerprints;
}

async function collectFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const absolutePath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectFiles(absolutePath)));
        continue;
      }

      if (entry.isFile()) {
        files.push(absolutePath);
      }
    }

    return files;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }
}

function diffSnapshots(beforeFiles: FileFingerprint[], afterFiles: FileFingerprint[]) {
  const beforeMap = new Map(beforeFiles.map((entry) => [entry.relativePath, entry]));
  const afterMap = new Map(afterFiles.map((entry) => [entry.relativePath, entry]));

  const changedFiles: FileDelta[] = [];
  const createdFiles: FileDelta[] = [];
  const removedFiles: FileDelta[] = [];

  for (const [relativePath, before] of beforeMap.entries()) {
    const after = afterMap.get(relativePath);
    if (!after) {
      removedFiles.push({ relativePath, before });
      continue;
    }

    if (
      before.sha256 !== after.sha256 ||
      before.size !== after.size ||
      before.modifiedMs !== after.modifiedMs
    ) {
      changedFiles.push({ relativePath, before, after });
    }
  }

  for (const [relativePath, after] of afterMap.entries()) {
    if (!beforeMap.has(relativePath)) {
      createdFiles.push({ relativePath, after });
    }
  }

  return { changedFiles, createdFiles, removedFiles };
}

function buildRationale(input: {
  authOnlyScenario: ProbeScenarioResult | undefined;
  explicitCredentialStore: string;
  fullHomeScenario: ProbeScenarioResult | undefined;
  inferredCredentialStore: string;
}): string[] {
  const rationale: string[] = [];

  rationale.push(
    `Observed credential-store config is ${input.explicitCredentialStore}, while the live home exposes ${input.inferredCredentialStore}.`,
  );

  if (input.fullHomeScenario) {
    rationale.push(
      `Full-home status probe changed: ${formatFileList(input.fullHomeScenario.changedFiles.map((entry) => entry.relativePath))}.`,
    );
  }

  if (input.authOnlyScenario?.commandSucceeded) {
    rationale.push("An auth-only home was sufficient for `codex login status`, which suggests `auth.json` is enough for read-only login inspection.");
  } else {
    rationale.push("An auth-only home failed `codex login status`, which means auth.json alone is not enough for operational wrapper switching.");
  }

  if (input.fullHomeScenario?.changedFiles.some((entry) => /(^|\/)(state_|logs_).+\.sqlite/i.test(entry.relativePath))) {
    rationale.push(
      "SQLite changed during a read-style command, so sqlite-backed runtime state must stay isolated per account instead of being merged into the shared runtime home.",
    );
  } else {
    rationale.push(
      "SQLite files were present but unchanged during the status probe, so they remain unproven rather than required; keep them protected until a real login or token-refresh probe proves they are safe.",
    );
  }

  return rationale;
}

function formatFileList(paths: string[]): string {
  if (paths.length === 0) {
    return "none";
  }

  return paths.join(", ");
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

async function main(): Promise<void> {
  const sourceCodexHome = process.env.CODEX_HOME_SOURCE ?? path.join(os.homedir(), ".codex");
  const codexBinary =
    process.env.CODEX_BINARY ?? (process.platform === "win32" ? "codex.cmd" : "codex");
  const workingRoot =
    process.env.CODEXES_PROBE_ROOT ?? path.join(process.cwd(), ".tmp", "auth-state-probe");

  await mkdir(workingRoot, { recursive: true });

  const report = await runAuthStateProbe({
    codexBinary,
    sourceCodexHome,
    workingRoot,
  });

  const outputPath = path.join(workingRoot, "report.json");
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  const summary: ConsoleProbeSummary = {
    outputPath,
    platform: report.platform,
    sourceCodexHome: report.sourceCodexHome,
    codexBinary: report.codexBinary,
    explicitCredentialStore: report.credentialStore.explicitMode,
    inferredCredentialStore: report.credentialStore.inferredFromArtifacts,
    authJsonAloneSufficient: report.conclusion.authJsonAloneSufficient,
    requiresSqliteIsolation: report.conclusion.requiresSqliteIsolation,
    scenarios: report.scenarios.map((scenario) => ({
      key: scenario.key,
      exitCode: scenario.commandExitCode,
      commandSucceeded: scenario.commandSucceeded,
      changedFiles: scenario.changedFiles.map((entry) => entry.relativePath),
      createdFiles: scenario.createdFiles.map((entry) => entry.relativePath),
      removedFiles: scenario.removedFiles.map((entry) => entry.relativePath),
    })),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const entrypointPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypointPath === path.resolve(fileURLToPath(import.meta.url))) {
  void main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "ERROR",
        event: "auth_probe.fatal",
        details: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      })}\n`,
    );
    process.exitCode = 1;
  });
}
