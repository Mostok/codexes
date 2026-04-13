import { access, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logging/logger.js";

export interface CodexBinaryResolution {
  path: string | null;
  candidates: string[];
  rejectedCandidates: Array<{ candidate: string; reason: string }>;
}

export async function findCodexBinary(input: {
  env: NodeJS.ProcessEnv;
  logger: Logger;
  wrapperExecutablePath: string;
}): Promise<CodexBinaryResolution> {
  const candidates = buildCandidates(input.env);
  const rejectedCandidates: Array<{ candidate: string; reason: string }> = [];

  input.logger.debug("binary_resolution.start", {
    wrapperExecutablePath: input.wrapperExecutablePath,
    candidateCount: candidates.length,
  });

  for (const candidate of candidates) {
    const reason = await getRejectionReason(candidate, input.wrapperExecutablePath);

    if (reason) {
      rejectedCandidates.push({ candidate, reason });
      input.logger.debug("binary_resolution.rejected", { candidate, reason });
      continue;
    }

    input.logger.info("binary_resolution.selected", { candidate });

    return {
      path: candidate,
      candidates,
      rejectedCandidates,
    };
  }

  input.logger.warn("binary_resolution.missing", {
    wrapperExecutablePath: input.wrapperExecutablePath,
    rejectedCandidates,
  });

  return {
    path: null,
    candidates,
    rejectedCandidates,
  };
}

function buildCandidates(env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH ?? "";
  const pathEntries = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const executableNames = process.platform === "win32"
    ? ["codex.cmd", "codex.exe", "codex.bat"]
    : ["codex"];

  return Array.from(
    new Set(
      pathEntries.flatMap((entry) =>
        executableNames.map((executableName) => path.join(entry, executableName)),
      ),
    ),
  );
}

async function getRejectionReason(
  candidate: string,
  wrapperExecutablePath: string,
): Promise<string | null> {
  try {
    await access(candidate);
  } catch {
    return "not_accessible";
  }

  const [candidateStat, wrapperStat] = await Promise.all([
    stat(candidate).catch(() => null),
    stat(wrapperExecutablePath).catch(() => null),
  ]);

  if (!candidateStat || !candidateStat.isFile()) {
    return "not_a_file";
  }

  if (wrapperStat && isSameFile(candidate, wrapperExecutablePath, candidateStat, wrapperStat)) {
    return "self_recursive_wrapper_path";
  }

  if (path.basename(candidate).toLowerCase().startsWith("codexes")) {
    return "wrapper_named_binary";
  }

  return null;
}

function isSameFile(
  candidate: string,
  wrapperExecutablePath: string,
  candidateStat: Awaited<ReturnType<typeof stat>>,
  wrapperStat: Awaited<ReturnType<typeof stat>>,
): boolean {
  if (path.resolve(candidate) === path.resolve(wrapperExecutablePath)) {
    return true;
  }

  return candidateStat.ino === wrapperStat.ino && candidateStat.dev === wrapperStat.dev;
}
