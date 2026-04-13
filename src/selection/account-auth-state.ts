import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AccountRecord } from "../accounts/account-registry.js";
import type { Logger } from "../logging/logger.js";

export type AccountAuthStateFailureCategory =
  | "missing-file"
  | "malformed-json"
  | "missing-access-token"
  | "unsupported-auth-shape";

export interface AccountAuthState {
  accessToken: string;
  accountId: string | null;
  authMode: string | null;
  lastRefresh: string | null;
}

export type AccountAuthStateReadResult =
  | {
      ok: true;
      filePath: string;
      state: AccountAuthState;
    }
  | {
      ok: false;
      category: AccountAuthStateFailureCategory;
      filePath: string;
      message: string;
    };

export async function readAccountAuthState(input: {
  account: AccountRecord;
  logger: Logger;
}): Promise<AccountAuthStateReadResult> {
  const filePath = path.join(input.account.authDirectory, "state", "auth.json");

  input.logger.debug("selection.account_auth_state.read_start", {
    accountId: input.account.id,
    label: input.account.label,
    filePath,
  });

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      input.logger.warn("selection.account_auth_state.unsupported_shape", {
        accountId: input.account.id,
        label: input.account.label,
        filePath,
        topLevelType: typeof parsed,
      });

      return {
        ok: false,
        category: "unsupported-auth-shape",
        filePath,
        message: "auth.json is not a JSON object.",
      };
    }

    const accessToken = resolveString(
      parsed.access_token,
      getNestedString(parsed, ["tokens", "access_token"]),
      getNestedString(parsed, ["tokens", "accessToken"]),
    );
    if (!accessToken) {
      input.logger.warn("selection.account_auth_state.access_token_missing", {
        accountId: input.account.id,
        label: input.account.label,
        filePath,
        hasTokensObject: isRecord(parsed.tokens),
      });

      return {
        ok: false,
        category: "missing-access-token",
        filePath,
        message: "auth.json does not contain an access_token.",
      };
    }

    const result: AccountAuthStateReadResult = {
      ok: true,
      filePath,
      state: {
        accessToken,
        accountId: resolveString(
          parsed.account_id,
          parsed.accountId,
          getNestedString(parsed, ["tokens", "account_id"]),
          getNestedString(parsed, ["tokens", "accountId"]),
        ),
        authMode: resolveString(
          parsed.auth_mode,
          parsed.authMode,
          getNestedString(parsed, ["tokens", "auth_mode"]),
          getNestedString(parsed, ["tokens", "authMode"]),
        ),
        lastRefresh: resolveString(
          parsed.last_refresh,
          parsed.lastRefresh,
          parsed.refresh_at,
          parsed.refreshAt,
        ),
      },
    };

    input.logger.debug("selection.account_auth_state.read_complete", {
      accountId: input.account.id,
      label: input.account.label,
      filePath,
      hasAccessToken: true,
      authAccountId: result.state.accountId,
      authMode: result.state.authMode,
      hasRefreshMetadata: result.state.lastRefresh !== null,
    });

    return result;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      input.logger.warn("selection.account_auth_state.missing_file", {
        accountId: input.account.id,
        label: input.account.label,
        filePath,
      });
      return {
        ok: false,
        category: "missing-file",
        filePath,
        message: "auth.json was not found for the account profile.",
      };
    }

    if (error instanceof SyntaxError) {
      input.logger.warn("selection.account_auth_state.malformed_json", {
        accountId: input.account.id,
        label: input.account.label,
        filePath,
        message: error.message,
      });
      return {
        ok: false,
        category: "malformed-json",
        filePath,
        message: error.message,
      };
    }

    input.logger.warn("selection.account_auth_state.unsupported_shape", {
      accountId: input.account.id,
      label: input.account.label,
      filePath,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      category: "unsupported-auth-shape",
      filePath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function getNestedString(value: Record<string, unknown>, pathParts: string[]): string | null {
  let current: unknown = value;

  for (const part of pathParts) {
    if (!isRecord(current) || typeof current[part] === "undefined") {
      return null;
    }

    current = current[part];
  }

  return typeof current === "string" && current.trim().length > 0 ? current : null;
}

function resolveString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
