import type { Logger } from "../logging/logger.js";

export interface SelectionSummaryTableCapabilities {
  stdoutIsTTY: boolean;
  useColor: boolean;
}

export interface SelectionSummaryTableColumn {
  align?: "left" | "right";
  key: string;
  header: string;
}

export function renderSelectionSummaryTable(input: {
  capabilities: SelectionSummaryTableCapabilities;
  columns: SelectionSummaryTableColumn[];
  footerLines: string[];
  logger: Logger;
  rows: Array<Record<string, string>>;
}): string {
  const renderStyle = resolveRenderStyle(input.capabilities);
  const sanitizedRows = input.rows.map((row, rowIndex) =>
    sanitizeRow({
      logger: input.logger,
      row,
      rowIndex,
    }),
  );
  const widths = resolveColumnWidths(input.columns, sanitizedRows);

  input.logger.debug("selection.render_table.start", {
    columnKeys: input.columns.map(({ key }) => key),
    footerLineCount: input.footerLines.length,
    renderStyle,
    rowCount: sanitizedRows.length,
    widths,
  });

  const topBorder = buildBorder(input.columns, widths);
  const header = buildRow(
    input.columns,
    widths,
    Object.fromEntries(input.columns.map((column) => [column.key, column.header])),
  );
  const body = sanitizedRows.map((row) => buildRow(input.columns, widths, row));
  const lines = [topBorder, header, topBorder, ...body, topBorder];

  if (input.footerLines.length > 0) {
    lines.push(...input.footerLines);
  }

  input.logger.debug("selection.render_table.complete", {
    footerAppended: input.footerLines.length > 0,
    renderStyle,
    rowCount: sanitizedRows.length,
    widths,
  });

  return lines.join("\n");
}

function resolveRenderStyle(capabilities: SelectionSummaryTableCapabilities): "plain" | "tty-color" | "tty-plain" {
  if (!capabilities.stdoutIsTTY) {
    return "plain";
  }

  return capabilities.useColor ? "tty-color" : "tty-plain";
}

function sanitizeRow(input: {
  logger: Logger;
  row: Record<string, string>;
  rowIndex: number;
}): Record<string, string> {
  const sanitizedEntries = Object.entries(input.row).map(([key, value]) => {
    const sanitizedValue = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
    if (sanitizedValue !== value) {
      input.logger.warn("selection.render_table.cell_sanitized", {
        columnKey: key,
        originalLength: value.length,
        rowIndex: input.rowIndex,
        sanitizedLength: sanitizedValue.length,
      });
    }

    return [key, sanitizedValue];
  });

  return Object.fromEntries(sanitizedEntries);
}

function resolveColumnWidths(
  columns: SelectionSummaryTableColumn[],
  rows: Array<Record<string, string>>,
): Record<string, number> {
  return Object.fromEntries(
    columns.map((column) => {
      const width = Math.max(
        measureDisplayWidth(column.header),
        ...rows.map((row) => measureDisplayWidth(row[column.key] ?? "")),
      );

      return [column.key, width];
    }),
  );
}

function buildBorder(
  columns: SelectionSummaryTableColumn[],
  widths: Record<string, number>,
): string {
  return `+${columns
    .map((column) => "-".repeat((widths[column.key] ?? measureDisplayWidth(column.header)) + 2))
    .join("+")}+`;
}

function buildRow(
  columns: SelectionSummaryTableColumn[],
  widths: Record<string, number>,
  row: Record<string, string>,
): string {
  const cells = columns.map((column) => {
    const value = row[column.key] ?? "";
    const width = widths[column.key] ?? Math.max(measureDisplayWidth(column.header), measureDisplayWidth(value));
    return ` ${padCell(value, width, column.align ?? "left")} `;
  });

  return `|${cells.join("|")}|`;
}

function padCell(value: string, width: number, align: "left" | "right"): string {
  const visibleWidth = measureDisplayWidth(value);
  const paddingWidth = Math.max(width - visibleWidth, 0);
  const padding = " ".repeat(paddingWidth);

  return align === "right" ? `${padding}${value}` : `${value}${padding}`;
}

function measureDisplayWidth(value: string): number {
  return stripAnsi(value).length;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
