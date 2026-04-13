import { access } from "node:fs/promises";
import path from "node:path";

export interface CodexLaunchSpec {
  args: string[];
  command: string;
}

export async function resolveCodexLaunchSpec(
  codexBinaryPath: string,
  args: string[],
): Promise<CodexLaunchSpec> {
  if (process.platform !== "win32") {
    return {
      command: codexBinaryPath,
      args,
    };
  }

  const npmShim = await resolveNpmCodexShim(codexBinaryPath);
  if (npmShim) {
    return {
      command: npmShim.nodeBinary,
      args: [npmShim.codexScript, ...args],
    };
  }

  if (/\.(cmd|bat)$/i.test(codexBinaryPath)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", buildCmdInvocation(codexBinaryPath, args)],
    };
  }

  if (/\.ps1$/i.test(codexBinaryPath)) {
    return {
      command: process.env.ComSpec
        ? "powershell.exe"
        : "pwsh",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        codexBinaryPath,
        ...args,
      ],
    };
  }

  return {
    command: codexBinaryPath,
    args,
  };
}

function buildCmdInvocation(binaryPath: string, args: string[]): string {
  return [quoteForCmd(binaryPath), ...args.map(quoteForCmd)].join(" ");
}

function quoteForCmd(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

async function resolveNpmCodexShim(
  codexBinaryPath: string,
): Promise<{ codexScript: string; nodeBinary: string } | null> {
  const basename = path.basename(codexBinaryPath).toLowerCase();
  if (!["codex", "codex.cmd", "codex.bat", "codex.ps1"].includes(basename)) {
    return null;
  }

  const directory = path.dirname(codexBinaryPath);
  const codexScript = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");

  if (!(await pathExists(codexScript))) {
    return null;
  }

  const bundledNode = path.join(directory, "node.exe");
  return {
    codexScript,
    nodeBinary: (await pathExists(bundledNode)) ? bundledNode : "node",
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
