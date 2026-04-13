import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = path.join(rootDir, "artifacts");
const installRoot = path.join(rootDir, ".tmp", "smoke-install");
const packageBin = path.join(installRoot, process.platform === "win32" ? "" : "bin");

try {
  const tarballPath = await findTarball();

  log("INFO", "smoke.start", {
    tarballPath,
    installRoot,
    platform: process.platform,
  });

  await rm(installRoot, { recursive: true, force: true });
  await mkdir(installRoot, { recursive: true });

  await runCommand("npm", ["install", "--prefix", installRoot, tarballPath], rootDir);

  const executable = process.platform === "win32"
    ? path.join(installRoot, "node_modules", ".bin", "codexes.cmd")
    : path.join(packageBin, "codexes");

  await runCommand(executable, ["--help"], rootDir);

  log("INFO", "smoke.complete", {
    executable,
    result: "ok",
  });
} catch (error) {
  log("ERROR", "smoke.failed", normalizeError(error));
  process.exitCode = 1;
}

async function findTarball() {
  const entries = await readdir(artifactsDir, { withFileTypes: true });
  const tarball = entries.find((entry) => entry.isFile() && entry.name.endsWith(".tgz"));

  if (!tarball) {
    throw new Error("No tarball found in artifacts/. Run npm run pack:tarball first.");
  }

  return path.join(artifactsDir, tarball.name);
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32",
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
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
