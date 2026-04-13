import { buildAppContext } from "./context.js";
import { createLogger } from "../logging/logger.js";
import { runRootCommand } from "../commands/root/run-root-command.js";

export interface BootstrapIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  executablePath: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export async function runCli(argv: string[], io: BootstrapIo): Promise<number> {
  const context = await buildAppContext(argv, io);
  const logger = createLogger({
    level: context.logging.level,
    name: "bootstrap",
    sink: context.logging.sink,
  });

  logger.debug("bootstrap.start", {
    argv,
    cwd: context.environment.cwd,
    platform: context.environment.platform,
    runtime: context.environment.runtime,
  });

  try {
    const exitCode = await runRootCommand(context);

    logger.debug("bootstrap.exit", { exitCode });

    return exitCode;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));

    logger.error("bootstrap.fatal", {
      message: normalized.message,
      stack: normalized.stack,
    });

    context.io.stderr.write(`codexes: ${normalized.message}\n`);

    return 1;
  }
}
