import { spawn } from "node:child_process";
import type { Logger } from "../logging/logger.js";
import { resolveCodexLaunchSpec } from "./codex-launch-spec.js";

export async function spawnCodexCommand(input: {
  argv: string[];
  codexBinaryPath: string;
  codexHome: string;
  logger: Logger;
}): Promise<number> {
  const launchSpec = await resolveCodexLaunchSpec(input.codexBinaryPath, input.argv);

  input.logger.info("spawn_codex.start", {
    codexBinaryPath: input.codexBinaryPath,
    resolvedCommand: launchSpec.command,
    codexHome: input.codexHome,
    argv: launchSpec.args,
    stdinIsTTY: process.stdin.isTTY ?? false,
    stdoutIsTTY: process.stdout.isTTY ?? false,
    stderrIsTTY: process.stderr.isTTY ?? false,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(launchSpec.command, launchSpec.args, {
      env: {
        ...process.env,
        CODEX_HOME: input.codexHome,
      },
      shell: false,
      stdio: "inherit",
      windowsHide: false,
    });
    let settled = false;

    const forwardSignal = (signal: NodeJS.Signals) => {
      input.logger.warn("spawn_codex.parent_signal", {
        signal,
        pid: child.pid ?? null,
      });
      child.kill(signal);
    };

    const signalHandlers = {
      SIGINT: () => forwardSignal("SIGINT"),
      SIGTERM: () => forwardSignal("SIGTERM"),
    } satisfies Partial<Record<NodeJS.Signals, () => void>>;

    process.on("SIGINT", signalHandlers.SIGINT);
    process.on("SIGTERM", signalHandlers.SIGTERM);

    const cleanup = () => {
      process.off("SIGINT", signalHandlers.SIGINT);
      process.off("SIGTERM", signalHandlers.SIGTERM);
    };

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      input.logger.error("spawn_codex.error", {
        codexBinaryPath: input.codexBinaryPath,
        message: error.message,
      });
      reject(error);
    });

    child.on("exit", (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      input.logger.info("spawn_codex.complete", {
        codexBinaryPath: input.codexBinaryPath,
        exitCode,
        signal,
      });
      resolve(exitCode ?? 1);
    });
  });
}
