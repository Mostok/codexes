import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../src/logging/logger.js";

export interface LoggedEvent {
  details: Record<string, unknown> | undefined;
  event: string;
  level: "debug" | "info" | "warn" | "error";
}

export function createTestLogger(): { events: LoggedEvent[]; logger: Logger } {
  const events: LoggedEvent[] = [];

  return {
    events,
    logger: {
      debug(event, details) {
        events.push({ level: "debug", event, details });
      },
      info(event, details) {
        events.push({ level: "info", event, details });
      },
      warn(event, details) {
        events.push({ level: "warn", event, details });
      },
      error(event, details) {
        events.push({ level: "error", event, details });
      },
    },
  };
}

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

export async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function waitForPath(filePath: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();

  while (true) {
    const existing = await stat(filePath).catch(() => null);
    if (existing) {
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for file: ${filePath}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function createCodexShim(input: {
  binRoot: string;
  scriptPath: string;
}): Promise<string> {
  await ensureDirectory(input.binRoot);

  if (process.platform === "win32") {
    const shimPath = path.join(input.binRoot, "codex.cmd");
    const escapedNode = process.execPath.replace(/"/g, '""');
    const escapedScript = input.scriptPath.replace(/"/g, '""');

    await writeFile(
      shimPath,
      `@echo off\r\n"${escapedNode}" "${escapedScript}" %*\r\n`,
      "utf8",
    );

    return shimPath;
  }

  const shimPath = path.join(input.binRoot, "codex");
  await writeFile(
    shimPath,
    `#!/usr/bin/env bash\n"${process.execPath}" "${input.scriptPath}" "$@"\n`,
    "utf8",
  );
  await import("node:fs/promises").then((fs) => fs.chmod(shimPath, 0o755));
  return shimPath;
}

export async function removeTempDir(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export function assertEvent(
  events: LoggedEvent[],
  event: string,
  level?: LoggedEvent["level"],
): void {
  const match = events.find((entry) => entry.event === event && (!level || entry.level === level));
  assert.ok(match, `Expected log event ${level ? `${level}:${event}` : event}`);
}
