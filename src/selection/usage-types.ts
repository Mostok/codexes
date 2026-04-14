export interface UsageQuotaWindowRaw {
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  limit_reached?: boolean | null;
  reset_at?: number | string | null;
  resets_at?: number | string | null;
  next_reset_at?: number | string | null;
  reset_after_seconds?: number | null;
  limit_window_seconds?: number | null;
  percent_used?: number | string | null;
  percentage_used?: number | string | null;
  used_percent?: number | string | null;
  [key: string]: unknown;
}

export interface WhamUsageResponseRaw {
  account_id?: string | null;
  accountId?: string | null;
  allowed?: boolean | null;
  limit_reached?: boolean | null;
  plan?: string | null;
  subscription_plan?: string | null;
  plan_type?: string | null;
  daily?: UsageQuotaWindowRaw | null;
  weekly?: UsageQuotaWindowRaw | null;
  usage?: {
    daily?: UsageQuotaWindowRaw | null;
    weekly?: UsageQuotaWindowRaw | null;
    [key: string]: unknown;
  } | null;
  quotas?: {
    daily?: UsageQuotaWindowRaw | null;
    weekly?: UsageQuotaWindowRaw | null;
    [key: string]: unknown;
  } | null;
  rate_limit?: {
    allowed?: boolean | null;
    limit_reached?: boolean | null;
    plan?: string | null;
    subscription_plan?: string | null;
    primary_window?: UsageQuotaWindowRaw | null;
    secondary_window?: UsageQuotaWindowRaw | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export type UsageSnapshotStatus =
  | "usable"
  | "not-allowed"
  | "limit-reached"
  | "missing-usage-data";

export interface NormalizedUsageWindow {
  limit: number | null;
  used: number | null;
  remaining: number | null;
  limitReached: boolean;
  resetsAt: string | null;
  percentUsed: number | null;
  source: string | null;
}

export interface NormalizedUsageSnapshot {
  accountId: string | null;
  allowed: boolean;
  limitReached: boolean;
  plan: string | null;
  dailyRemaining: number | null;
  weeklyRemaining: number | null;
  dailyResetsAt: string | null;
  weeklyResetsAt: string | null;
  dailyPercentUsed: number | null;
  weeklyPercentUsed: number | null;
  observedAt: string;
  status: UsageSnapshotStatus;
  statusReason: string;
  windows: {
    daily: NormalizedUsageWindow;
    weekly: NormalizedUsageWindow;
  };
}
