const USER_PAID_DATE_PATTERN = /^(\d{2})\.(\d{2})\.(\d{4})$/;

export interface ParsedAccountPaidDate {
  displayValue: string;
  isoValue: string;
}

export function parseAccountPaidDate(input: {
  logger: {
    debug(event: string, details?: Record<string, unknown>): void;
    warn(event: string, details?: Record<string, unknown>): void;
  };
  rawValue: string;
  source: string;
}): ParsedAccountPaidDate {
  const normalizedValue = input.rawValue.trim();

  input.logger.debug("account_paid_date.parse_start", {
    rawValue: input.rawValue,
    normalizedValue,
    source: input.source,
  });

  const match = USER_PAID_DATE_PATTERN.exec(normalizedValue);
  if (!match) {
    input.logger.warn("account_paid_date.parse_invalid_format", {
      rawValue: input.rawValue,
      normalizedValue,
      source: input.source,
    });
    throw new Error(
      `Invalid paid date "${input.rawValue}". Expected format: dd.mm.yyyy.`,
    );
  }

  const dayValue = match[1];
  const monthValue = match[2];
  const yearValue = match[3];
  if (!dayValue || !monthValue || !yearValue) {
    input.logger.warn("account_paid_date.parse_invalid_match_groups", {
      rawValue: input.rawValue,
      normalizedValue,
      source: input.source,
    });
    throw new Error(
      `Invalid paid date "${input.rawValue}". Expected format: dd.mm.yyyy.`,
    );
  }
  const day = Number.parseInt(dayValue, 10);
  const month = Number.parseInt(monthValue, 10);
  const year = Number.parseInt(yearValue, 10);
  const timestamp = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(timestamp.getTime()) ||
    timestamp.getUTCFullYear() !== year ||
    timestamp.getUTCMonth() !== month - 1 ||
    timestamp.getUTCDate() !== day
  ) {
    input.logger.warn("account_paid_date.parse_invalid_calendar_date", {
      rawValue: input.rawValue,
      normalizedValue,
      source: input.source,
    });
    throw new Error(
      `Invalid paid date "${input.rawValue}". Expected a real calendar date in format dd.mm.yyyy.`,
    );
  }

  const parsedDate = {
    displayValue: normalizedValue,
    isoValue: timestamp.toISOString(),
  };

  input.logger.debug("account_paid_date.parse_complete", {
    displayValue: parsedDate.displayValue,
    isoValue: parsedDate.isoValue,
    source: input.source,
  });

  return parsedDate;
}

export function formatAccountPaidDateDisplay(value: string): string | null {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }

  return [
    String(timestamp.getUTCDate()).padStart(2, "0"),
    String(timestamp.getUTCMonth() + 1).padStart(2, "0"),
    String(timestamp.getUTCFullYear()),
  ].join(".");
}
