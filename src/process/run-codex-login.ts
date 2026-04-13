import { spawn } from "node:child_process";
import type { Logger } from "../logging/logger.js";
import { resolveCodexLaunchSpec } from "./codex-launch-spec.js";

export interface CodexLoginResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  timeoutMs: number;
  cancelledBySignal: boolean;
}

export async function runInteractiveCodexLogin(input: {
  codexBinaryPath: string;
  codexHome: string;
  logger: Logger;
  timeoutMs: number;
}): Promise<CodexLoginResult> {
  const launchSpec = await resolveCodexLaunchSpec(input.codexBinaryPath, ["login"]);

  input.logger.info("login.spawn.start", {
    codexBinaryPath: input.codexBinaryPath,
    resolvedCommand: launchSpec.command,
    codexHome: input.codexHome,
    argv: launchSpec.args,
    timeoutMs: input.timeoutMs,
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
    let timedOut = false;
    let cancelledBySignal = false;
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      input.logger.warn("login.spawn.timeout", {
        codexBinaryPath: input.codexBinaryPath,
        codexHome: input.codexHome,
        timeoutMs: input.timeoutMs,
      });
      terminateChild(child);
    }, input.timeoutMs);

    const forwardSignal = (signal: NodeJS.Signals) => {
      cancelledBySignal = true;
      input.logger.warn("login.spawn.parent_signal", {
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
      clearTimeout(timeoutHandle);
      process.off("SIGINT", signalHandlers.SIGINT);
      process.off("SIGTERM", signalHandlers.SIGTERM);
    };

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      input.logger.error("login.spawn.error", {
        codexBinaryPath: input.codexBinaryPath,
        codexHome: input.codexHome,
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

      input.logger.info("login.spawn.complete", {
        codexBinaryPath: input.codexBinaryPath,
        codexHome: input.codexHome,
        exitCode,
        signal,
        timedOut,
        cancelledBySignal,
      });

      resolve({
        exitCode,
        signal,
        timedOut,
        timeoutMs: input.timeoutMs,
        cancelledBySignal,
      });
    });
  });
}

function terminateChild(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32") {
    child.kill();
    return;
  }

  child.kill("SIGTERM");
}
