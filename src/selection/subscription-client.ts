import type { AccountRecord } from "../accounts/account-registry.js";
import type { Logger } from "../logging/logger.js";
import { readAccountAuthState } from "./account-auth-state.js";

const SUBSCRIPTIONS_URL = "https://chatgpt.com/backend-api/subscriptions";
const SUBSCRIPTION_TIMEOUT_MS = 4_000;
const BROWSER_LIKE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

export interface AccountSubscriptionExpiration {
  displayValue: string | null;
  isoValue: string | null;
  source: string;
}

export async function resolveAccountSubscriptionExpiration(input: {
  account: AccountRecord;
  fetchImpl?: typeof fetch;
  logger: Logger;
}): Promise<AccountSubscriptionExpiration> {
  input.logger.debug("selection.subscription_expiration.resolve_start", {
    accountId: input.account.id,
    label: input.account.label,
  });

  const authState = await readAccountAuthState({
    account: input.account,
    logger: input.logger,
  });
  if (!authState.ok) {
    input.logger.debug("selection.subscription_expiration.auth_missing", {
      accountId: input.account.id,
      label: input.account.label,
      category: authState.category,
    });
    return completeWithEmptyResult(input, "auth-missing");
  }

  try {
    const response = await fetchSubscriptionResponse({
      accessToken: authState.state.accessToken,
      accountId: authState.state.accountId,
      fetchImpl: input.fetchImpl ?? fetch,
      logger: input.logger,
      registryAccountId: input.account.id,
    });

    if (!response.ok) {
      input.logger.debug("selection.subscription_expiration.http_error", {
        accountId: input.account.id,
        label: input.account.label,
        status: response.status,
      });
      return completeWithEmptyResult(input, "http-error");
    }

    const body = await readSubscriptionJson(response, input);
    const activeUntil = readActiveUntilValue(body);
    if (!activeUntil.present) {
      input.logger.debug("selection.subscription_expiration.active_until_missing", {
        accountId: input.account.id,
        label: input.account.label,
        bodyShape: describeJsonShape(body),
      });
      return completeWithEmptyResult(input, "active-until-missing");
    }

    const isoValue = normalizeActiveUntilValue(activeUntil.value);
    if (!isoValue) {
      input.logger.debug("selection.subscription_expiration.active_until_invalid", {
        accountId: input.account.id,
        label: input.account.label,
        candidateType: typeof activeUntil.value,
      });
      return completeWithEmptyResult(input, "active-until-invalid");
    }

    const displayValue = formatSubscriptionExpirationDisplay(isoValue);
    if (!displayValue) {
      input.logger.debug("selection.subscription_expiration.active_until_invalid", {
        accountId: input.account.id,
        label: input.account.label,
        candidateType: "normalized-date",
      });
      return completeWithEmptyResult(input, "active-until-invalid");
    }

    input.logger.debug("selection.subscription_expiration.resolve_complete", {
      accountId: input.account.id,
      label: input.account.label,
      displayValue,
      source: "active_until",
    });

    return {
      displayValue,
      isoValue,
      source: "active_until",
    };
  } catch (error) {
    if (error instanceof InvalidSubscriptionJsonError) {
      return completeWithEmptyResult(input, "invalid-json");
    }

    if (isAbortError(error)) {
      input.logger.debug("selection.subscription_expiration.timeout", {
        accountId: input.account.id,
        label: input.account.label,
        timeoutMs: SUBSCRIPTION_TIMEOUT_MS,
      });
      return completeWithEmptyResult(input, "timeout");
    }

    input.logger.debug("selection.subscription_expiration.request_failed", {
      accountId: input.account.id,
      label: input.account.label,
      message: error instanceof Error ? error.message : String(error),
    });
    return completeWithEmptyResult(input, "request-failed");
  }
}

export function formatSubscriptionExpirationDisplay(value: string): string | null {
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

async function fetchSubscriptionResponse(input: {
  accessToken: string;
  accountId: string | null;
  fetchImpl: typeof fetch;
  logger: Logger;
  registryAccountId: string;
}): Promise<Response> {
  const url = buildSubscriptionUrl(input.accountId);
  const response = await input.fetchImpl(url, {
    method: "GET",
    headers: buildSubscriptionHeaders({
      accessToken: input.accessToken,
    }),
    signal: AbortSignal.timeout(SUBSCRIPTION_TIMEOUT_MS),
  });

  input.logger.debug("selection.subscription_expiration.http_complete", {
    accountId: input.registryAccountId,
    hasAuthAccountId: input.accountId !== null,
    status: response.status,
    ok: response.ok,
  });

  return response;
}

function buildSubscriptionUrl(accountId: string | null): string {
  if (!accountId) {
    return SUBSCRIPTIONS_URL;
  }

  const url = new URL(SUBSCRIPTIONS_URL);
  url.searchParams.set("account_id", accountId);
  return url.toString();
}

function buildSubscriptionHeaders(input: {
  accessToken: string;
}): Headers {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${input.accessToken}`,
    "user-agent": BROWSER_LIKE_USER_AGENT,
  });

  return headers;
}

async function readSubscriptionJson(
  response: Response,
  input: {
    account: AccountRecord;
    logger: Logger;
  },
): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    input.logger.debug("selection.subscription_expiration.invalid_json", {
      accountId: input.account.id,
      label: input.account.label,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new InvalidSubscriptionJsonError();
  }
}

function completeWithEmptyResult(
  input: {
    account: AccountRecord;
    logger: Logger;
  },
  source: string,
): AccountSubscriptionExpiration {
  input.logger.debug("selection.subscription_expiration.resolve_complete", {
    accountId: input.account.id,
    label: input.account.label,
    displayValue: "-",
    source,
  });

  return emptyExpiration(source);
}

function emptyExpiration(source: string): AccountSubscriptionExpiration {
  return {
    displayValue: null,
    isoValue: null,
    source,
  };
}

function readActiveUntilValue(body: unknown): { present: boolean; value: unknown } {
  if (!isRecord(body) || !Object.hasOwn(body, "active_until")) {
    return { present: false, value: null };
  }

  return { present: true, value: body.active_until };
}

function normalizeActiveUntilValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    return null;
  }

  const timestamp = new Date(normalizedValue);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function describeJsonShape(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }

  if (isRecord(value)) {
    return `object:${Object.keys(value).slice(0, 8).join(",")}`;
  }

  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class InvalidSubscriptionJsonError extends Error {
  constructor() {
    super("Subscription response was not valid JSON.");
    this.name = "InvalidSubscriptionJsonError";
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
