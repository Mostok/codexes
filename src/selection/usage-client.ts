import type { AccountRecord } from "../accounts/account-registry.js";
import type { ExperimentalSelectionConfig } from "../config/wrapper-config.js";
import type { Logger } from "../logging/logger.js";
import { readAccountAuthState } from "./account-auth-state.js";
import { normalizeWhamUsageResponse } from "./usage-normalize.js";
import type { NormalizedUsageSnapshot, WhamUsageResponseRaw } from "./usage-types.js";

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export type UsageProbeFailureCategory =
  | "auth-missing"
  | "timeout"
  | "http-error"
  | "invalid-response";

export type AccountUsageProbeResult =
  | {
      ok: true;
      account: AccountRecord;
      snapshot: NormalizedUsageSnapshot;
      source: "fresh";
    }
  | {
      ok: false;
      account: AccountRecord;
      category: UsageProbeFailureCategory;
      message: string;
      source: "fresh";
    };

export async function probeAccountUsage(input: {
  account: AccountRecord;
  fetchImpl?: typeof fetch;
  logger: Logger;
  probeConfig: ExperimentalSelectionConfig;
}): Promise<AccountUsageProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;

  input.logger.info("selection.usage_probe.start", {
    accountId: input.account.id,
    label: input.account.label,
    timeoutMs: input.probeConfig.probeTimeoutMs,
    useAccountIdHeader: input.probeConfig.useAccountIdHeader,
  });

  const authState = await readAccountAuthState({
    account: input.account,
    logger: input.logger,
  });
  if (!authState.ok) {
    input.logger.warn("selection.usage_probe.auth_missing", {
      accountId: input.account.id,
      label: input.account.label,
      category: authState.category,
      filePath: authState.filePath,
    });

    return {
      ok: false,
      account: input.account,
      category: "auth-missing",
      message: authState.message,
      source: "fresh",
    };
  }

  try {
    const response = await fetchImpl(WHAM_USAGE_URL, {
      method: "GET",
      headers: buildUsageHeaders({
        accessToken: authState.state.accessToken,
        accountId: authState.state.accountId,
        useAccountIdHeader: input.probeConfig.useAccountIdHeader,
      }),
      signal: AbortSignal.timeout(input.probeConfig.probeTimeoutMs),
    });

    input.logger.debug("selection.usage_probe.http_complete", {
      accountId: input.account.id,
      label: input.account.label,
      status: response.status,
      ok: response.ok,
    });

    if (!response.ok) {
      input.logger.warn("selection.usage_probe.http_error", {
        accountId: input.account.id,
        label: input.account.label,
        status: response.status,
      });
      return {
        ok: false,
        account: input.account,
        category: "http-error",
        message: `Usage probe returned HTTP ${response.status}.`,
        source: "fresh",
      };
    }

    const body = (await response.json()) as unknown;
    if (!isRecord(body)) {
      input.logger.warn("selection.usage_probe.invalid_response", {
        accountId: input.account.id,
        label: input.account.label,
        bodyType: typeof body,
      });
      return {
        ok: false,
        account: input.account,
        category: "invalid-response",
        message: "Usage probe returned a non-object JSON payload.",
        source: "fresh",
      };
    }

    const snapshot = normalizeWhamUsageResponse({
      accountIdHint: authState.state.accountId ?? input.account.id,
      logger: input.logger,
      raw: body as WhamUsageResponseRaw,
    });

    input.logger.info("selection.usage_probe.success", {
      accountId: input.account.id,
      label: input.account.label,
      snapshotStatus: snapshot.status,
      dailyRemaining: snapshot.dailyRemaining,
      weeklyRemaining: snapshot.weeklyRemaining,
      limitReached: snapshot.limitReached,
    });

    return {
      ok: true,
      account: input.account,
      snapshot,
      source: "fresh",
    };
  } catch (error) {
    if (isAbortError(error)) {
      input.logger.warn("selection.usage_probe.timeout", {
        accountId: input.account.id,
        label: input.account.label,
        timeoutMs: input.probeConfig.probeTimeoutMs,
      });
      return {
        ok: false,
        account: input.account,
        category: "timeout",
        message: `Usage probe timed out after ${input.probeConfig.probeTimeoutMs}ms.`,
        source: "fresh",
      };
    }

    input.logger.error("selection.usage_probe.request_failed", {
      accountId: input.account.id,
      label: input.account.label,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      account: input.account,
      category: "invalid-response",
      message: error instanceof Error ? error.message : String(error),
      source: "fresh",
    };
  }
}

function buildUsageHeaders(input: {
  accessToken: string;
  accountId: string | null;
  useAccountIdHeader: boolean;
}): Headers {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${input.accessToken}`,
    "user-agent": "codexes/0.1 experimental-usage-probe",
  });

  if (input.useAccountIdHeader && input.accountId) {
    headers.set("OpenAI-Account-ID", input.accountId);
  }

  return headers;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
