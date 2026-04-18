import type { Logger } from "../logging/logger.js";
import type {
  SelectionFallbackReason,
  SelectionSummary,
  SelectionSummaryEntry,
} from "./selection-summary.js";
import {
  renderSelectionSummaryTable,
  type SelectionSummaryTableColumn,
} from "./render-selection-summary-table.js";

interface SummaryRenderCapabilities {
  stdoutIsTTY: boolean;
  useColor: boolean;
}

export type SelectionSummaryRenderVariant = "display-table" | "execution-summary";

export function formatSelectionSummary(input: {
  capabilities: SummaryRenderCapabilities;
  logger: Logger;
  now?: Date;
  renderVariant: SelectionSummaryRenderVariant;
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
    renderVariant: input.renderVariant,
    columnSet: input.renderVariant === "display-table"
      ? ["label", "account", "paidAt", "flags", "status", "5h", "weekly", "plan", "source"]
      : ["summary-lines"],
    footerBlocks: ["selected-account", "fallback", "execution-note"],
    fallbackReason: input.summary.fallbackReason,
    selectedAccountId: input.summary.selectedAccount?.id ?? null,
    executionBlockedReason: input.summary.executionBlockedReason,
  });

  const footerLines = buildFooterLines(input.summary);
  const renderedBody = input.renderVariant === "display-table"
    ? renderDisplayTable({
        capabilities: input.capabilities,
        footerLines,
        logger: input.logger,
        now: input.now ?? new Date(),
        summary: input.summary,
      })
    : renderExecutionSummary({
        capabilities: input.capabilities,
        footerLines,
        summary: input.summary,
      });

  const lineCount = renderedBody.split("\n").length;

  input.logger.debug("selection.format_summary.complete", {
    mode: input.summary.mode,
    strategy: input.summary.strategy,
    renderMode,
    renderVariant: input.renderVariant,
    lineCount,
    columnSet: input.renderVariant === "display-table"
      ? ["label", "account", "paidAt", "flags", "status", "5h", "weekly", "plan", "source"]
      : ["summary-lines"],
    fallbackIncluded: input.summary.fallbackReason !== null,
    footerIncluded: {
      executionNote: input.summary.executionBlockedReason !== null,
      fallback: input.summary.fallbackReason !== null,
      selectedAccount: true,
    },
    selectedAccountId: input.summary.selectedAccount?.id ?? null,
    executionBlockedReason: input.summary.executionBlockedReason,
  });

  return `${renderedBody}\n`;
}

function renderDisplayTable(input: {
  capabilities: SummaryRenderCapabilities;
  footerLines: string[];
  logger: Logger;
  now: Date;
  summary: SelectionSummary;
}): string {
  const columns: SelectionSummaryTableColumn[] = [
    { header: "Label", key: "label" },
    { header: "Account ID", key: "account" },
    { header: "Payed at", key: "paidAt" },
    { header: "Flags", key: "flags" },
    { header: "Status", key: "status" },
    { align: "right", header: "5h", key: "fiveHour" },
    { align: "right", header: "Weekly", key: "weekly" },
    { header: "Plan", key: "plan" },
    { header: "Source", key: "source" },
  ];

  return [
    "Account selection summary:",
    renderSelectionSummaryTable({
      capabilities: input.capabilities,
      columns,
      footerLines: input.footerLines,
      logger: input.logger,
      rows: input.summary.entries.map((entry) =>
        formatSelectionTableRow(entry, input.capabilities, input.logger)
      ),
    }),
  ].join("\n");
}

function renderExecutionSummary(input: {
  capabilities: SummaryRenderCapabilities;
  footerLines: string[];
  summary: SelectionSummary;
}): string {
  return [
    "Account selection summary:",
    ...input.summary.entries.map((entry) =>
      formatSelectionEntry(entry, input.capabilities),
    ),
    ...input.footerLines,
  ].join("\n");
}

function buildFooterLines(summary: SelectionSummary): string[] {
  const lines: string[] = [];
  if (summary.selectedAccount && summary.selectedBy) {
    lines.push(
      `Selected account: ${summary.selectedAccount.label} (${summary.selectedAccount.id}) via ${describeSelectionMode(summary)}.`,
    );
  } else {
    lines.push("Selected account: unavailable for execution.");
  }

  if (summary.fallbackReason) {
    lines.push(`Fallback: ${describeFallback(summary.fallbackReason)}.`);
  }
  if (summary.executionBlockedReason) {
    lines.push(`Execution note: ${summary.executionBlockedReason}`);
  }

  return lines;
}

function formatSelectionEntry(
  entry: SelectionSummaryEntry,
  capabilities: SummaryRenderCapabilities,
): string {
  const tags = formatSelectionTags(entry);
  const status = resolveStatus(entry);
  const detail = resolveDetail(entry);

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

function formatSelectionTableRow(
  entry: SelectionSummaryEntry,
  capabilities: SummaryRenderCapabilities,
  logger: Logger,
): Record<string, string> {
  const status = resolveStatus(entry);

  return {
    account: entry.account.id,
    fiveHour: colorize(
      capabilities,
      mapRemainingTone(entry.snapshot?.dailyRemaining ?? null),
      formatPercent(entry.snapshot?.dailyRemaining ?? null),
    ),
    flags: formatSelectionTags(entry) || "-",
    label: entry.account.label,
    paidAt: formatPaidAt(entry, logger),
    plan: entry.snapshot?.plan
      ? colorize(capabilities, "planValue", entry.snapshot.plan)
      : "-",
    source: colorize(capabilities, "source", entry.source),
    status: colorize(capabilities, mapStatusTone(status), status),
    weekly: colorize(
      capabilities,
      mapRemainingTone(entry.snapshot?.weeklyRemaining ?? null),
      formatPercent(entry.snapshot?.weeklyRemaining ?? null),
    ),
  };
}

function formatPaidAt(
  entry: SelectionSummaryEntry,
  logger: Logger,
): string {
  logger.debug("selection.format_paid_at.start", {
    accountId: entry.account.id,
    paidAt: entry.paidAt,
    label: entry.account.label,
  });

  if (!entry.paidAt.displayValue || !entry.paidAt.isoValue) {
    logger.debug("selection.format_paid_at.complete", {
      accountId: entry.account.id,
      formattedPaidAt: "-",
      source: "missing",
    });
    return "-";
  }

  const normalizedDate = new Date(entry.paidAt.isoValue);
  if (Number.isNaN(normalizedDate.getTime())) {
    logger.warn("selection.format_paid_at.invalid", {
      accountId: entry.account.id,
      paidAt: entry.paidAt,
      label: entry.account.label,
    });
    return "-";
  }

  logger.debug("selection.format_paid_at.complete", {
    accountId: entry.account.id,
    formattedPaidAt: entry.paidAt.displayValue,
    source: entry.paidAt.source,
  });

  return entry.paidAt.displayValue;
}

function formatSelectionTags(entry: SelectionSummaryEntry): string {
  return [
    entry.isSelected ? "selected" : null,
    entry.isDefault ? "default" : null,
    entry.rankingPosition !== null ? `rank #${entry.rankingPosition}` : null,
  ]
    .filter((value): value is string => value !== null)
    .join(", ");
}

function resolveStatus(entry: SelectionSummaryEntry): string {
  return entry.snapshot?.status ?? (entry.failureCategory ? "probe-failed" : "not-probed");
}

function resolveDetail(entry: SelectionSummaryEntry): string {
  return (
    entry.failureMessage ??
    entry.snapshot?.statusReason ??
    "usage probing was not required for this strategy"
  );
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
