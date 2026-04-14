import type { Logger } from "../logging/logger.js";
import type {
  NormalizedUsageSnapshot,
  NormalizedUsageWindow,
  UsageQuotaWindowRaw,
  UsageSnapshotStatus,
  WhamUsageResponseRaw,
} from "./usage-types.js";

export function normalizeWhamUsageResponse(input: {
  accountIdHint?: string | null;
  logger: Logger;
  raw: WhamUsageResponseRaw;
}): NormalizedUsageSnapshot {
  const payloadShape = resolvePayloadShape(input.raw);
  const dailyWindow = resolveUsageWindow(input.raw, "daily");
  const weeklyWindow = resolveUsageWindow(input.raw, "weekly");

  input.logger.debug("selection.usage_normalize.start", {
    accountIdHint: input.accountIdHint ?? null,
    payloadShape,
    hasPrimaryWindow: dailyWindow.source === "rate_limit.primary_window",
    hasSecondaryWindow: weeklyWindow.source === "rate_limit.secondary_window",
    topLevelKeys: Object.keys(input.raw).sort(),
  });

  const daily = normalizeUsageWindow({
    accountIdHint: input.accountIdHint,
    logger: input.logger,
    raw: dailyWindow.raw,
    source: dailyWindow.source,
    window: "daily",
  });
  const weekly = normalizeUsageWindow({
    accountIdHint: input.accountIdHint,
    logger: input.logger,
    raw: weeklyWindow.raw,
    source: weeklyWindow.source,
    window: "weekly",
  });
  const accountId = pickString(input.raw.account_id, input.raw.accountId, input.accountIdHint);
  const plan = pickString(
    input.raw.plan,
    input.raw.subscription_plan,
    input.raw.plan_type,
    input.raw.rate_limit?.plan,
    input.raw.rate_limit?.subscription_plan,
  );
  const allowed = pickBoolean(input.raw.allowed, input.raw.rate_limit?.allowed, true) ?? true;
  const limitReached =
    (pickBoolean(input.raw.limit_reached, input.raw.rate_limit?.limit_reached) ??
      daily.limitReached) ||
    weekly.limitReached;
  const status = classifyUsageStatus({
    allowed,
    dailyRemaining: daily.remaining,
    limitReached,
    weeklyRemaining: weekly.remaining,
  });
  const statusEvent = `selection.usage_normalize.status_${status}`;
  const statusDetails = {
    accountId,
    accountIdHint: input.accountIdHint ?? null,
    allowed,
    payloadShape,
    dailyRemaining: daily.remaining,
    weeklyRemaining: weekly.remaining,
    dailyWindowSource: daily.source,
    weeklyWindowSource: weekly.source,
    hasRemainingPercent: daily.remaining !== null || weekly.remaining !== null,
  };
  if (status === "usable") {
    input.logger.info(statusEvent, statusDetails);
  } else {
    input.logger.warn(statusEvent, statusDetails);
  }
  const snapshot: NormalizedUsageSnapshot = {
    accountId,
    allowed,
    limitReached,
    plan,
    dailyRemaining: daily.remaining,
    weeklyRemaining: weekly.remaining,
    dailyResetsAt: daily.resetsAt,
    weeklyResetsAt: weekly.resetsAt,
    dailyPercentUsed: daily.percentUsed,
    weeklyPercentUsed: weekly.percentUsed,
    observedAt: new Date().toISOString(),
    status,
    statusReason: describeUsageStatus(status),
    windows: {
      daily,
      weekly,
    },
  };

  input.logger.debug("selection.usage_normalize.complete", {
    accountId: snapshot.accountId,
    allowed: snapshot.allowed,
    payloadShape,
    limitReached: snapshot.limitReached,
    plan: snapshot.plan,
    dailyRemaining: snapshot.dailyRemaining,
    weeklyRemaining: snapshot.weeklyRemaining,
    dailyResetsAt: snapshot.dailyResetsAt,
    weeklyResetsAt: snapshot.weeklyResetsAt,
    status: snapshot.status,
    statusReason: snapshot.statusReason,
  });

  return snapshot;
}

function normalizeUsageWindow(input: {
  accountIdHint?: string | null;
  logger: Logger;
  raw: UsageQuotaWindowRaw | null;
  source: string | null;
  window: "daily" | "weekly";
}): NormalizedUsageWindow {
  if (!input.raw) {
    input.logger.debug("selection.usage_normalize.window_missing", {
      accountIdHint: input.accountIdHint ?? null,
      source: input.source,
      window: input.window,
    });

    return {
      limit: null,
      used: null,
      remaining: null,
      limitReached: false,
      resetsAt: null,
      percentUsed: null,
      source: input.source,
    };
  }

  const limit = pickNumber(input.raw.limit);
  const percentResolution = resolveUsedPercent({
    accountIdHint: input.accountIdHint,
    logger: input.logger,
    raw: input.raw,
    window: input.window,
  });
  const remainingFromPercent = calculateRemainingFromPercent(percentResolution.percentUsed);
  const used = pickNumber(
    input.raw.used,
    calculateUsed(limit, pickNumber(input.raw.remaining)),
    calculateUsed(limit, remainingFromPercent),
  );
  const remaining = pickNumber(
    input.raw.remaining,
    remainingFromPercent,
    calculateRemaining(limit, used),
  );
  const limitReached =
    typeof input.raw.limit_reached === "boolean"
      ? input.raw.limit_reached
      : remaining !== null
        ? remaining <= 0
        : false;
  const percentUsed =
    percentResolution.percentUsed ?? calculatePercentUsed(limit, used, remaining);
  const resetsAt = normalizeTimestamp(
    input.raw.reset_at,
    input.raw.resets_at,
    input.raw.next_reset_at,
    calculateResetAtFromSeconds(input.raw.reset_after_seconds),
  );
  const source = resolveWindowSource(input.raw, input.source);

  input.logger.debug("selection.usage_normalize.window_complete", {
    accountIdHint: input.accountIdHint ?? null,
    window: input.window,
    source,
    limit,
    used,
    remaining,
    limitReached,
    rawUsedPercent: percentResolution.rawValue,
    percentResolutionSource: percentResolution.source,
    percentUsed,
    resetsAt,
    limitWindowSeconds: pickNumber(input.raw.limit_window_seconds),
  });

  return {
    limit,
    used,
    remaining,
    limitReached,
    resetsAt,
    percentUsed,
    source,
  };
}

function resolveUsageWindow(
  raw: WhamUsageResponseRaw,
  window: "daily" | "weekly",
): { raw: UsageQuotaWindowRaw | null; source: string | null } {
  const rateLimitWindow =
    window === "daily" ? raw.rate_limit?.primary_window : raw.rate_limit?.secondary_window;
  if (isRecord(rateLimitWindow)) {
    return {
      raw: rateLimitWindow as UsageQuotaWindowRaw,
      source: `rate_limit.${window === "daily" ? "primary_window" : "secondary_window"}`,
    };
  }

  const candidates: Array<{ raw: unknown; source: string }> = [
    { raw: raw[window], source: `legacy.${window}` },
    { raw: raw.usage?.[window], source: `usage.${window}` },
    { raw: raw.quotas?.[window], source: `quotas.${window}` },
  ];

  for (const candidate of candidates) {
    if (isRecord(candidate.raw)) {
      return {
        raw: candidate.raw as UsageQuotaWindowRaw,
        source: candidate.source,
      };
    }
  }

  return {
    raw: null,
    source: null,
  };
}

function resolveWindowSource(raw: UsageQuotaWindowRaw, fallbackSource: string | null): string | null {
  if (typeof raw.source === "string") {
    return raw.source;
  }

  if (typeof raw.kind === "string") {
    return raw.kind;
  }

  return fallbackSource;
}

function resolvePayloadShape(raw: WhamUsageResponseRaw): "legacy" | "rate_limit" {
  if (
    isRecord(raw.rate_limit) &&
    (isRecord(raw.rate_limit.primary_window) || isRecord(raw.rate_limit.secondary_window))
  ) {
    return "rate_limit";
  }

  return "legacy";
}

function classifyUsageStatus(input: {
  allowed: boolean;
  dailyRemaining: number | null;
  limitReached: boolean;
  weeklyRemaining: number | null;
}): UsageSnapshotStatus {
  if (!input.allowed) {
    return "not-allowed";
  }

  if (input.limitReached) {
    return "limit-reached";
  }

  if (input.dailyRemaining === null && input.weeklyRemaining === null) {
    return "missing-usage-data";
  }

  return "usable";
}

function describeUsageStatus(status: UsageSnapshotStatus): string {
  switch (status) {
    case "not-allowed":
      return "usage endpoint reported that the account is not allowed to launch";
    case "limit-reached":
      return "usage endpoint reported an exhausted limit window";
    case "missing-usage-data":
      return "usage endpoint did not expose enough quota fields to rank this account";
    case "usable":
      return "usage endpoint exposed enough quota fields to rank this account";
  }
}

function normalizeTimestamp(...values: Array<number | string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.valueOf())) {
        return parsed.toISOString();
      }
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      const normalizedValue = value > 10_000_000_000 ? value : value * 1_000;
      const parsed = new Date(normalizedValue);
      if (!Number.isNaN(parsed.valueOf())) {
        return parsed.toISOString();
      }
    }
  }

  return null;
}

function calculateResetAtFromSeconds(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return new Date(Date.now() + value * 1_000).toISOString();
}

function calculateRemaining(
  limit: number | null,
  used: number | null,
): number | null {
  if (limit === null || used === null) {
    return null;
  }

  return limit - used;
}

function calculateUsed(
  limit: number | null,
  remaining: number | null,
): number | null {
  if (limit === null || remaining === null) {
    return null;
  }

  return limit - remaining;
}

function calculatePercentUsed(
  limit: number | null,
  used: number | null,
  remaining: number | null,
): number | null {
  if (limit === null || limit <= 0) {
    return null;
  }

  const numerator = used ?? calculateUsed(limit, remaining);
  if (numerator === null) {
    return null;
  }

  return Number(((numerator / limit) * 100).toFixed(2));
}

function calculateRemainingFromPercent(percentUsed: number | null): number | null {
  if (percentUsed === null) {
    return null;
  }

  return Number((100 - percentUsed).toFixed(2));
}

function resolveUsedPercent(input: {
  accountIdHint?: string | null;
  logger: Logger;
  raw: UsageQuotaWindowRaw;
  window: "daily" | "weekly";
}): {
  percentUsed: number | null;
  rawValue: number | string | null;
  source: "used_percent" | "percent_used" | "percentage_used" | "missing" | "invalid";
} {
  const candidates: Array<{
    source: "used_percent" | "percent_used" | "percentage_used";
    value: number | string | null | undefined;
  }> = [
    { source: "used_percent", value: input.raw.used_percent },
    { source: "percent_used", value: input.raw.percent_used },
    { source: "percentage_used", value: input.raw.percentage_used },
  ];

  for (const candidate of candidates) {
    if (candidate.value === null || candidate.value === undefined || candidate.value === "") {
      continue;
    }

    const parsed = normalizePercentValue(candidate.value);
    if (parsed === null) {
      input.logger.debug("selection.usage_normalize.percent_invalid", {
        accountIdHint: input.accountIdHint ?? null,
        window: input.window,
        source: candidate.source,
        rawValue: candidate.value,
        behavior: "skip",
      });
      return {
        percentUsed: null,
        rawValue: typeof candidate.value === "string" || typeof candidate.value === "number"
          ? candidate.value
          : null,
        source: "invalid",
      };
    }

    if (parsed.wasClamped) {
      input.logger.debug("selection.usage_normalize.percent_clamped", {
        accountIdHint: input.accountIdHint ?? null,
        window: input.window,
        source: candidate.source,
        rawValue: candidate.value,
        clampedValue: parsed.value,
      });
    }

    input.logger.debug("selection.usage_normalize.percent_resolved", {
      accountIdHint: input.accountIdHint ?? null,
      window: input.window,
      source: candidate.source,
      rawValue: candidate.value,
      percentUsed: parsed.value,
      remainingPercent: calculateRemainingFromPercent(parsed.value),
    });

    return {
      percentUsed: parsed.value,
      rawValue: typeof candidate.value === "string" || typeof candidate.value === "number"
        ? candidate.value
        : null,
      source: candidate.source,
    };
  }

  input.logger.debug("selection.usage_normalize.percent_missing", {
    accountIdHint: input.accountIdHint ?? null,
    window: input.window,
    fallback: "derive-from-limit-or-remaining-if-possible",
  });

  return {
    percentUsed: null,
    rawValue: null,
    source: "missing",
  };
}

function normalizePercentValue(
  value: number | string,
): { value: number; wasClamped: boolean } | null {
  const numericValue =
    typeof value === "number"
      ? value
      : value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  const clampedValue = Math.min(100, Math.max(0, numericValue));
  return {
    value: Number(clampedValue.toFixed(2)),
    wasClamped: clampedValue !== numericValue,
  };
}

function pickString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function pickNumber(
  ...values: Array<number | null | undefined>
): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function pickBoolean(
  ...values: Array<boolean | null | undefined>
): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
