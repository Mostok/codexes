import path from "node:path";
import type { Logger } from "../logging/logger.js";

const PROJECT_LOCAL_CODEX_PATH_PATTERN =
  /(?:[A-Za-z]:[\\/]|\/)[^"'`\r\n]*?\.codex(?:[\\/][^"'`\r\n]*)?/g;

export function sanitizeProjectLocalConfigPaths(input: {
  configPath: string;
  logger: Logger;
  projectRoot: string;
  rawConfig: string;
}): string {
  const lines = input.rawConfig.split(/\r?\n/);
  const sanitizedLines: string[] = [];
  let removedLineCount = 0;
  let scannedPathCount = 0;

  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith("#")) {
      sanitizedLines.push(line);
      continue;
    }

    const projectLocalPaths = extractProjectLocalCodexPaths(line);
    if (projectLocalPaths.length === 0) {
      sanitizedLines.push(line);
      continue;
    }

    scannedPathCount += projectLocalPaths.length;
    const stalePaths = projectLocalPaths.filter(
      (candidatePath) => !isPathInsideRoot(candidatePath, input.projectRoot),
    );

    if (stalePaths.length === 0) {
      input.logger.debug("codex.trust.project_local_paths_kept", {
        configPath: input.configPath,
        lineNumber: index + 1,
        projectRoot: input.projectRoot,
        projectLocalPaths,
      });
      sanitizedLines.push(line);
      continue;
    }

    removedLineCount += 1;
    input.logger.warn("codex.trust.project_local_paths_removed", {
      configPath: input.configPath,
      lineNumber: index + 1,
      projectRoot: input.projectRoot,
      stalePaths,
    });
  }

  input.logger.debug("codex.trust.config_scan_complete", {
    configPath: input.configPath,
    projectRoot: input.projectRoot,
    removedLineCount,
    scannedPathCount,
  });

  const sanitizedConfig = sanitizedLines.join("\n");
  return input.rawConfig.endsWith("\n") && !sanitizedConfig.endsWith("\n")
    ? `${sanitizedConfig}\n`
    : sanitizedConfig;
}

function extractProjectLocalCodexPaths(line: string): string[] {
  return [...line.matchAll(PROJECT_LOCAL_CODEX_PATH_PATTERN)].map((match) => match[0]);
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const candidateStyle = detectPathStyle(candidatePath);
  const rootStyle = detectPathStyle(rootPath);
  if (!candidateStyle || !rootStyle || candidateStyle !== rootStyle) {
    return false;
  }

  const pathApi = candidateStyle === "win32" ? path.win32 : path.posix;
  const normalizedCandidate = normalizeForComparison(pathApi.resolve(candidatePath), candidateStyle);
  const normalizedRoot = normalizeForComparison(pathApi.resolve(rootPath), candidateStyle);
  if (normalizedCandidate === normalizedRoot) {
    return true;
  }

  const separator = candidateStyle === "win32" ? "\\" : "/";
  return normalizedCandidate.startsWith(`${normalizedRoot}${separator}`);
}

function detectPathStyle(inputPath: string): "win32" | "posix" | null {
  if (/^[A-Za-z]:[\\/]/.test(inputPath)) {
    return "win32";
  }

  if (inputPath.startsWith("/")) {
    return "posix";
  }

  return null;
}

function normalizeForComparison(
  resolvedPath: string,
  pathStyle: "win32" | "posix",
): string {
  return pathStyle === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}
