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
  input.logger.debug("selection.usage_normalize.start", {
    accountIdHint: input.accountIdHint ?? null,
    topLevelKeys: Object.keys(input.raw).sort(),
  });

  const daily = normalizeUsageWindow({
    accountIdHint: input.accountIdHint,
    logger: input.logger,
    raw: resolveUsageWindow(input.raw, "daily"),
    window: "daily",
  });
  const weekly = normalizeUsageWindow({
    accountIdHint: input.accountIdHint,
    logger: input.logger,
    raw: resolveUsageWindow(input.raw, "weekly"),
    window: "weekly",
  });
  const accountId = pickString(input.raw.account_id, input.raw.accountId, input.accountIdHint);
  const allowed = typeof input.raw.allowed === "boolean" ? input.raw.allowed : true;
  const limitReached =
    typeof input.raw.limit_reached === "boolean"
      ? input.raw.limit_reached
      : daily.limitReached || weekly.limitReached;
  const status = classifyUsageStatus({
    allowed,
    dailyRemaining: daily.remaining,
    limitReached,
    weeklyRemaining: weekly.remaining,
  });
  const snapshot: NormalizedUsageSnapshot = {
    accountId,
    allowed,
    limitReached,
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
    limitReached: snapshot.limitReached,
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
  window: "daily" | "weekly";
}): NormalizedUsageWindow {
  if (!input.raw) {
    input.logger.debug("selection.usage_normalize.window_missing", {
      accountIdHint: input.accountIdHint ?? null,
      window: input.window,
    });

    return {
      limit: null,
      used: null,
      remaining: null,
      limitReached: false,
      resetsAt: null,
      percentUsed: null,
      source: null,
    };
  }

  const limit = pickNumber(input.raw.limit);
  const used = pickNumber(input.raw.used, calculateUsed(limit, pickNumber(input.raw.remaining)));
  const remaining = pickNumber(
    input.raw.remaining,
    calculateRemaining(limit, used),
  );
  const limitReached =
    typeof input.raw.limit_reached === "boolean"
      ? input.raw.limit_reached
      : remaining !== null
        ? remaining <= 0
        : false;
  const percentUsed = pickNumber(
    input.raw.percent_used,
    input.raw.percentage_used,
    calculatePercentUsed(limit, used, remaining),
  );
  const resetsAt = normalizeTimestamp(
    input.raw.reset_at,
    input.raw.resets_at,
    input.raw.next_reset_at,
  );
  const source = resolveWindowSource(input.raw);

  input.logger.debug("selection.usage_normalize.window_complete", {
    accountIdHint: input.accountIdHint ?? null,
    window: input.window,
    limit,
    used,
    remaining,
    limitReached,
    percentUsed,
    resetsAt,
    source,
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
): UsageQuotaWindowRaw | null {
  const candidates = [raw[window], raw.usage?.[window], raw.quotas?.[window]];

  for (const candidate of candidates) {
    if (isRecord(candidate)) {
      return candidate as UsageQuotaWindowRaw;
    }
  }

  return null;
}

function resolveWindowSource(raw: UsageQuotaWindowRaw): string | null {
  if (typeof raw.source === "string") {
    return raw.source;
  }

  if (typeof raw.kind === "string") {
    return raw.kind;
  }

  return null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
