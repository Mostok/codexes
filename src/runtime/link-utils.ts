import path from "node:path";
import { link, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import type { Logger } from "../logging/logger.js";

export type RuntimeLinkType =
  | "junction"
  | "directory-symlink"
  | "file-symlink"
  | "hardlink";

export interface EnsuredRuntimeLink {
  action: "created" | "repaired" | "reused";
  linkType: RuntimeLinkType;
}

export async function ensureRuntimeLink(input: {
  isDirectory: boolean;
  logger: Logger;
  logContext: Record<string, unknown>;
  logPrefix: string;
  sourcePath: string;
  targetPath: string;
}): Promise<EnsuredRuntimeLink> {
  const existingLinkTarget = await readlink(input.targetPath).catch(() => null);
  if (
    existingLinkTarget &&
    path.resolve(path.dirname(input.targetPath), existingLinkTarget) === path.resolve(input.sourcePath)
  ) {
    return {
      action: "reused",
      linkType: input.isDirectory ? resolveDirectoryLinkType() : "file-symlink",
    };
  }

  if (!input.isDirectory && (await isSameFile(input.sourcePath, input.targetPath))) {
    input.logger.debug(`${input.logPrefix}.hardlink_reused`, {
      ...input.logContext,
      sourcePath: input.sourcePath,
      targetPath: input.targetPath,
    });
    return {
      action: "reused",
      linkType: "hardlink",
    };
  }

  const existedBeforeRepair = await pathExists(input.targetPath);
  if (existedBeforeRepair) {
    input.logger.debug(`${input.logPrefix}.replace_existing`, {
      ...input.logContext,
      sourcePath: input.sourcePath,
      targetPath: input.targetPath,
    });
  }

  await rm(input.targetPath, { force: true, recursive: true }).catch(() => undefined);
  await mkdir(path.dirname(input.targetPath), { recursive: true });

  let linkType: RuntimeLinkType;
  if (input.isDirectory) {
    linkType = resolveDirectoryLinkType();
    await symlink(input.sourcePath, input.targetPath, process.platform === "win32" ? "junction" : "dir");
  } else {
    try {
      await symlink(input.sourcePath, input.targetPath, "file");
      linkType = "file-symlink";
    } catch (error) {
      input.logger.debug(`${input.logPrefix}.file_symlink_fallback`, {
        ...input.logContext,
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        message: error instanceof Error ? error.message : String(error),
      });
      await link(input.sourcePath, input.targetPath);
      linkType = "hardlink";
    }
  }

  return {
    action: existedBeforeRepair ? "repaired" : "created",
    linkType,
  };
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

export async function removePathIfExists(input: {
  logger: Logger;
  logContext: Record<string, unknown>;
  logPrefix: string;
  reason: string;
  removePath?: typeof rm;
  targetPath: string;
}): Promise<boolean> {
  if (!(await pathExists(input.targetPath))) {
    return false;
  }

  const removePath = input.removePath ?? rm;
  try {
    await removePath(input.targetPath, { force: true, recursive: true });
  } catch (error) {
    if (isBestEffortRemoveError(error)) {
      input.logger.warn(`${input.logPrefix}.remove_skipped`, {
        ...input.logContext,
        message:
          "[FIX] Ignoring locked stale codex-home entry during reconcile; launch will continue.",
        reason: input.reason,
        targetPath: input.targetPath,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    throw error;
  }
  input.logger.debug(`${input.logPrefix}.removed`, {
    ...input.logContext,
    reason: input.reason,
    targetPath: input.targetPath,
  });
  return true;
}

function isBestEffortRemoveError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return error.code === "EBUSY" || error.code === "EPERM";
}

async function isSameFile(sourcePath: string, targetPath: string): Promise<boolean> {
  const [sourceStats, targetStats] = await Promise.all([
    lstat(sourcePath).catch(() => null),
    lstat(targetPath).catch(() => null),
  ]);
  if (!sourceStats || !targetStats) {
    return false;
  }

  return sourceStats.dev === targetStats.dev && sourceStats.ino === targetStats.ino;
}

function resolveDirectoryLinkType(): RuntimeLinkType {
  return process.platform === "win32" ? "junction" : "directory-symlink";
}
