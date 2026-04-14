import { createLogSink, createLogger, resolveLogLevel } from "../logging/logger.js";
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
    sink: ReturnType<typeof createLogSink>;
  };
  paths: ReturnType<typeof resolvePaths>;
  runtimeInitialization: Awaited<ReturnType<typeof initializeRuntimeEnvironment>>;
  wrapperConfig: Awaited<ReturnType<typeof resolveWrapperConfig>>;
  codexBinary: Awaited<ReturnType<typeof findCodexBinary>>;
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
  const logLevel = resolveLogLevel(io.env.LOG_LEVEL);
  const sink = createLogSink(io.stderr);
  const paths = resolvePaths(io.cwd, io.env);
  const runtimeInitialization = await initializeRuntimeEnvironment({
    env: io.env,
    logger: createLogger({
      level: logLevel,
      name: "runtime",
      sink,
    }),
    paths,
  });
  const wrapperConfig = await resolveWrapperConfig({
    env: io.env,
    logger: createLogger({
      level: logLevel,
      name: "config",
      sink,
    }),
    paths,
  });
  const codexBinary = await findCodexBinary({
    env: io.env,
    logger: createLogger({
      level: logLevel,
      name: "process",
      sink,
    }),
    wrapperExecutablePath: io.executablePath,
  });

  createLogger({
    level: logLevel,
    name: "context",
    sink,
  }).debug("initialized", {
    argv,
    cwd: io.cwd,
    logLevel,
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
      level: logLevel,
      sink,
    },
    paths,
    runtimeInitialization,
    wrapperConfig,
    codexBinary,
  };
}
