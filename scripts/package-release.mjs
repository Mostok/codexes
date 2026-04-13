import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = path.join(rootDir, "artifacts");

try {
  await mkdir(artifactsDir, { recursive: true });
  await rmContents(artifactsDir);

  log("INFO", "package.start", {
    platform: process.platform,
    strategy: "npm-tarball",
    artifactsDir,
  });

  const output = await runCommand("npm", ["pack", "--pack-destination", artifactsDir], rootDir);
  const tarballName = output.trim().split(/\r?\n/).at(-1);

  if (!tarballName) {
    throw new Error("npm pack did not report a tarball name.");
  }

  log("INFO", "package.complete", {
    artifact: path.join(artifactsDir, tarballName),
    smokeTestCommand: "npm run smoke:packaged",
  });
} catch (error) {
  log("ERROR", "package.failed", normalizeError(error));
  process.exitCode = 1;
}

async function rmContents(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  await Promise.all(
    entries.map((entry) =>
      rm(path.join(directory, entry.name), {
        force: true,
        recursive: true,
      }),
    ),
  );
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "inherit"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`));
    });

    child.on("error", reject);
  });
}

function log(level, event, details) {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      details,
    })}\n`,
  );
}

function normalizeError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}
