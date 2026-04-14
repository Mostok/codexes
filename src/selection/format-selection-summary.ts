import type { Logger } from "../logging/logger.js";
import type {
  SelectionFallbackReason,
  SelectionSummary,
  SelectionSummaryEntry,
} from "./selection-summary.js";

interface SummaryRenderCapabilities {
  stdoutIsTTY: boolean;
  useColor: boolean;
}

export function formatSelectionSummary(input: {
  capabilities: SummaryRenderCapabilities;
  logger: Logger;
  summary: SelectionSummary;
}): string {
  const renderMode = input.capabilities.useColor ? "color" : "plain";

  input.logger.debug("selection.format_summary.start", {
    mode: input.summary.mode,
    strategy: input.summary.strategy,
    entryCount: input.summary.entries.length,
    stdoutIsTTY: input.capabilities.stdoutIsTTY,
    useColor: input.capabilities.useColor,
    renderMode,
    fallbackReason: input.summary.fallbackReason,
    selectedAccountId: input.summary.selectedAccount?.id ?? null,
    executionBlockedReason: input.summary.executionBlockedReason,
  });

  const lines = [
    "Account selection summary:",
    ...input.summary.entries.map((entry) =>
      formatSelectionEntry(entry, input.capabilities),
    ),
  ];

  if (input.summary.selectedAccount && input.summary.selectedBy) {
    lines.push(
      `Selected account: ${input.summary.selectedAccount.label} (${input.summary.selectedAccount.id}) via ${describeSelectionMode(input.summary)}.`,
    );
  } else {
    lines.push("Selected account: unavailable for execution.");
  }

  if (input.summary.fallbackReason) {
    lines.push(`Fallback: ${describeFallback(input.summary.fallbackReason)}.`);
  }
  if (input.summary.executionBlockedReason) {
    lines.push(`Execution note: ${input.summary.executionBlockedReason}`);
  }

  input.logger.debug("selection.format_summary.complete", {
    mode: input.summary.mode,
    strategy: input.summary.strategy,
    renderMode,
    lineCount: lines.length,
    fallbackIncluded: input.summary.fallbackReason !== null,
    selectedAccountId: input.summary.selectedAccount?.id ?? null,
    executionBlockedReason: input.summary.executionBlockedReason,
  });

  return `${lines.join("\n")}\n`;
}

function formatSelectionEntry(
  entry: SelectionSummaryEntry,
  capabilities: SummaryRenderCapabilities,
): string {
  const tags = [
    entry.isSelected ? "selected" : null,
    entry.isDefault ? "default" : null,
    entry.rankingPosition !== null ? `rank #${entry.rankingPosition}` : null,
  ]
    .filter((value): value is string => value !== null)
    .join(", ");

  const status = entry.snapshot?.status ?? (entry.failureCategory ? "probe-failed" : "not-probed");
  const detail =
    entry.failureMessage ??
    entry.snapshot?.statusReason ??
    "usage probing was not required for this strategy";

  return [
    "-",
    `${entry.account.label} (${entry.account.id})`,
    tags ? colorize(capabilities, "tag", `[${tags}]`) : null,
    colorize(capabilities, mapStatusTone(status), `status=${status}`),
    formatWindowMetric(capabilities, "5h", entry.snapshot?.dailyRemaining ?? null),
    formatWindowMetric(capabilities, "weekly", entry.snapshot?.weeklyRemaining ?? null),
    entry.snapshot?.plan
      ? `${colorize(capabilities, "plan", "plan")}=${colorize(capabilities, "planValue", entry.snapshot.plan)}`
      : null,
    colorize(capabilities, "source", `source=${entry.source}`),
    `detail=${describeDetailMarker(entry, detail)}`,
  ]
    .filter((value): value is string => value !== null)
    .join(" ");
}

function formatPercent(value: number | null): string {
  return value === null ? "unknown" : `${trimTrailingZeroes(value)}%`;
}

function formatWindowMetric(
  capabilities: SummaryRenderCapabilities,
  label: "5h" | "weekly",
  value: number | null,
): string {
  const renderedPercent = colorize(
    capabilities,
    mapRemainingTone(value),
    formatPercent(value),
  );
  return `${colorize(capabilities, "windowLabel", label)}=${renderedPercent}`;
}

function describeSelectionMode(summary: SelectionSummary): string {
  if (summary.selectedBy === null) {
    return "no execution selection";
  }

  switch (summary.selectedBy) {
    case "experimental-ranked":
      return "remaining-limit";
    case "single-account":
      return "single-account";
    case "manual-default":
      return "manual-default";
    case "manual-default-fallback-single":
      return summary.fallbackReason
        ? "manual-default fallback because only one account was available"
        : "manual-default because only one account is configured";
  }
}

function describeFallback(reason: SelectionFallbackReason): string {
  switch (reason) {
    case "experimental-config-missing":
      return "remaining-limit probing was unavailable, so codexes fell back to manual-default";
    case "all-probes-failed":
      return "every account probe failed, so codexes could not establish a reliable execution winner";
    case "mixed-probe-outcomes":
      return "some account probes failed, so codexes could not establish a reliable execution winner";
    case "all-accounts-exhausted":
      return "all probed accounts were exhausted, so codexes could not establish a reliable execution winner";
    case "ambiguous-usage":
      return "the usage data was incomplete or ambiguous, so codexes could not establish a reliable execution winner";
    case null:
      return "no fallback was required";
  }
}

function describeDetailMarker(entry: SelectionSummaryEntry, detail: string): string {
  if (entry.failureCategory === "timeout") {
    return "probe-timeout";
  }

  if (entry.failureCategory === "http-error") {
    return "http-error";
  }

  if (entry.failureCategory === "auth-missing") {
    return "auth-missing";
  }

  if (entry.failureCategory === "invalid-response") {
    return "invalid-response";
  }

  switch (entry.snapshot?.status) {
    case "usable":
      return "rankable";
    case "limit-reached":
      return "exhausted";
    case "not-allowed":
      return "blocked";
    case "missing-usage-data":
      return "incomplete";
    default:
      return detail.includes("not required") ? "not-probed" : "diagnostic";
  }
}

function mapStatusTone(status: string): "source" | "success" | "muted" | "warning" | "error" {
  switch (status) {
    case "usable":
      return "success";
    case "limit-reached":
      return "warning";
    case "probe-failed":
    case "not-allowed":
      return "error";
    default:
      return "muted";
  }
}

function colorize(
  capabilities: SummaryRenderCapabilities,
  tone: "source" | "success" | "muted" | "warning" | "error" | "tag" | "windowLabel" | "plan" | "planValue",
  value: string,
): string {
  if (!capabilities.useColor) {
    return value;
  }

  const open = ANSI_CODES[tone];
  return `${open}${value}${ANSI_RESET}`;
}

function mapRemainingTone(
  value: number | null,
): "success" | "warning" | "error" | "muted" {
  if (value === null) {
    return "muted";
  }

  if (value <= 20) {
    return "error";
  }

  if (value <= 50) {
    return "warning";
  }

  return "success";
}

function trimTrailingZeroes(value: number): string {
  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

const ANSI_RESET = "\u001b[0m";
const ANSI_CODES: Record<
  "source" | "success" | "muted" | "warning" | "error" | "tag" | "windowLabel" | "plan" | "planValue",
  string
> = {
  source: "\u001b[36m",
  success: "\u001b[32m",
  muted: "\u001b[90m",
  warning: "\u001b[33m",
  error: "\u001b[31m",
  tag: "\u001b[1m",
  windowLabel: "\u001b[94m",
  plan: "\u001b[95m",
  planValue: "\u001b[1;95m",
};
