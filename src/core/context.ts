import {
  createLogSink,
  createLogger,
  createSilentLogSink,
  type Logger,
  resolveLogLevel,
  type LogLevel,
  type LogSink,
} from "../logging/logger.js";
import { resolveWrapperConfig } from "../config/wrapper-config.js";
import { resolvePaths } from "./paths.js";
import { findCodexBinary } from "../process/find-codex-binary.js";
import { initializeRuntimeEnvironment } from "../runtime/init/initialize-runtime.js";

export interface AppContext {
  argv: string[];
  executablePath: string;
  environment: {
    cwd: string;
    platform: NodeJS.Platform;
    runtime: string;
  };
  io: {
    stdout: NodeJS.WriteStream;
    stderr: NodeJS.WriteStream;
  };
  output: {
    stdoutIsTTY: boolean;
  };
  logging: {
    level: string;
    sink: LogSink;
  };
  paths: ReturnType<typeof resolvePaths>;
  runtimeInitialization: Awaited<ReturnType<typeof initializeRuntimeEnvironment>>;
  wrapperConfig: Awaited<ReturnType<typeof resolveWrapperConfig>>;
  codexBinary: Awaited<ReturnType<typeof findCodexBinary>>;
}

export interface AppLoggingContext {
  level: LogLevel;
  sink: LogSink;
  logger: Logger;
}

export function createAppLoggingContext(input: {
  env: NodeJS.ProcessEnv;
  stderr: NodeJS.WriteStream;
  loggerName?: string;
}): AppLoggingContext {
  const level = resolveLogLevel(input.env.LOG_LEVEL);
  // Keep structured diagnostics available in DEBUG mode without polluting user stderr by default.
  const sink = level === "DEBUG" ? createLogSink(input.stderr) : createSilentLogSink();

  return {
    level,
    sink,
    logger: createLogger({
      level,
      name: input.loggerName ?? "context",
      sink,
    }),
  };
}

export async function buildAppContext(
  argv: string[],
  io: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    executablePath: string;
    stdout: NodeJS.WriteStream;
    stderr: NodeJS.WriteStream;
  },
): Promise<AppContext> {
  const logging = createAppLoggingContext({
    env: io.env,
    stderr: io.stderr,
  });
  const paths = resolvePaths(io.cwd, io.env);
  const runtimeInitialization = await initializeRuntimeEnvironment({
    env: io.env,
    logger: createLogger({
      level: logging.level,
      name: "runtime",
      sink: logging.sink,
    }),
    paths,
  });
  const wrapperConfig = await resolveWrapperConfig({
    env: io.env,
    logger: createLogger({
      level: logging.level,
      name: "config",
      sink: logging.sink,
    }),
    paths,
  });
  const codexBinary = await findCodexBinary({
    env: io.env,
    logger: createLogger({
      level: logging.level,
      name: "process",
      sink: logging.sink,
    }),
    wrapperExecutablePath: io.executablePath,
  });

  logging.logger.debug("initialized", {
    argv,
    cwd: io.cwd,
    logLevel: logging.level,
    paths,
    runtimeInitialization,
    wrapperConfig,
    codexBinary,
  });

  return {
    argv,
    executablePath: io.executablePath,
    environment: {
      cwd: io.cwd,
      platform: process.platform,
      runtime: process.version,
    },
    io: {
      stdout: io.stdout,
      stderr: io.stderr,
    },
    output: {
      stdoutIsTTY: io.stdout.isTTY === true,
    },
    logging: {
      level: logging.level,
      sink: logging.sink,
    },
    paths,
    runtimeInitialization,
    wrapperConfig,
    codexBinary,
  };
}
