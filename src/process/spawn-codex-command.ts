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
  const launchPolicy = extractLaunchPolicy(launchSpec.args);
  const launchCwd = process.cwd();

  input.logger.info("spawn_codex.start", {
    codexBinaryPath: input.codexBinaryPath,
    resolvedCommand: launchSpec.command,
    codexHome: input.codexHome,
    cwd: launchCwd,
    argv: launchSpec.args,
    sandboxMode: launchPolicy.sandboxMode,
    approvalMode: launchPolicy.approvalMode,
    stdinIsTTY: process.stdin.isTTY ?? false,
    stdoutIsTTY: process.stdout.isTTY ?? false,
    stderrIsTTY: process.stderr.isTTY ?? false,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(launchSpec.command, launchSpec.args, {
      cwd: launchCwd,
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
        cwd: launchCwd,
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
        cwd: launchCwd,
        sandboxMode: launchPolicy.sandboxMode,
        approvalMode: launchPolicy.approvalMode,
      });
      resolve(exitCode ?? 1);
    });
  });
}

function extractLaunchPolicy(args: string[]): {
  approvalMode: string | null;
  sandboxMode: string | null;
} {
  return {
    approvalMode: findOptionValue(args, ["--ask-for-approval", "--approval-mode"]),
    sandboxMode: findOptionValue(args, ["--sandbox"]),
  };
}

function findOptionValue(args: string[], names: string[]): string | null {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const value = args[index];
    if (!value) {
      continue;
    }

    for (const name of names) {
      if (value === name) {
        return args[index + 1] ?? null;
      }

      if (value.startsWith(`${name}=`)) {
        return value.slice(name.length + 1);
      }
    }
  }

  return null;
}
