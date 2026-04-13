import { mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { spawn } from "node:child_process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const tsconfigPath = path.join(rootDir, "tsconfig.json");
const entryPoint = path.join(rootDir, "src", "cli.ts");
const outfile = path.join(distDir, "cli.js");

try {
  log("INFO", "build.start", {
    rootDir,
    platform: process.platform,
    target: "node20",
    outfile,
  });

  await mkdir(distDir, { recursive: true });
  await runTypeScriptDeclarations(tsconfigPath);

  await build({
    absWorkingDir: rootDir,
    bundle: true,
    entryPoints: [entryPoint],
    format: "esm",
    outfile,
    platform: "node",
    sourcemap: true,
    target: "node20",
    banner: {
      js: "#!/usr/bin/env node",
    },
    logLevel: "silent",
  });

  if (process.platform !== "win32") {
    await chmod(outfile, 0o755);
  }

  log("INFO", "build.complete", {
    declarationDir: distDir,
    outfile,
    packagingStrategy: "npm-tarball",
  });
} catch (error) {
  const normalized = normalizeError(error);
  log("ERROR", "build.failed", normalized);
  process.exitCode = 1;
}

function runTypeScriptDeclarations(tsconfig) {
  log("DEBUG", "build.declarations.start", { tsconfig });

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(rootDir, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        tsconfig,
      ],
      {
        cwd: rootDir,
        stdio: "inherit",
      },
    );

    child.on("exit", (code) => {
      if (code === 0) {
        log("DEBUG", "build.declarations.complete", { tsconfig });
        resolve();
        return;
      }

      reject(new Error(`TypeScript declaration build failed with exit code ${code ?? "unknown"}.`));
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
