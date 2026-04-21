import { buildAppContext, createAppLoggingContext } from "./context.js";
import { createLogger, type Logger } from "../logging/logger.js";
import { runRootCommand } from "../commands/root/run-root-command.js";

export interface BootstrapIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  executablePath: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export async function runCli(argv: string[], io: BootstrapIo): Promise<number> {
  let context: Awaited<ReturnType<typeof buildAppContext>> | undefined;
  const fallbackLogging = createAppLoggingContext({
    env: io.env,
    stderr: io.stderr,
    loggerName: "bootstrap",
  });
  let logger: Logger = fallbackLogging.logger;

  try {
    context = await buildAppContext(argv, io);
    logger = createLogger({
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

    const exitCode = await runRootCommand(context);

    logger.debug("bootstrap.exit", { exitCode });

    return exitCode;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));

    logger.error("bootstrap.fatal", {
      message: normalized.message,
      stack: normalized.stack,
      phase: context === undefined ? "context_initialization" : "command_execution",
    });

    const stderr = context?.io.stderr ?? io.stderr;
    stderr.write(`codexes: ${resolveUserFacingErrorMessage(normalized)}\n`);

    return 1;
  }
}

function resolveUserFacingErrorMessage(error: Error): string {
  const message = error.message.trim();
  if (message.length === 0 || looksLikeInternalError(message)) {
    return "Command failed. Re-run with LOG_LEVEL=DEBUG to inspect diagnostics.";
  }

  return message;
}

function looksLikeInternalError(message: string): boolean {
  return (
    message.includes("\n") ||
    message.includes("\r") ||
    /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|AggregateError|URIError|EvalError|ENOENT|ENOTDIR|EACCES|EMFILE|ERR_)\b/.test(message) ||
    /\b(?:Cannot find module|Cannot read properties|Unexpected token|node:internal|node:fs|node:path)\b/i.test(
      message,
    ) ||
    /(?:^|[\s(])(?:[A-Za-z]:[\\/]|\/(?:private|tmp|var|home|users|z|e)\/)/i.test(message) ||
    /node_modules[\\/]/i.test(message) ||
    /\bat\s+\S+\s+\(/.test(message) ||
    message.toLowerCase().includes("stack")
  );
}
