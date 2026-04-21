import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { AccountRecord } from "../src/accounts/account-registry.js";
import { resolveAccountSubscriptionExpiration } from "../src/selection/subscription-client.js";
import {
  assertEvent,
  createTempDir,
  createTestLogger,
  removeTempDir,
  writeJson,
} from "./test-helpers.js";

test("subscription client requests active_until with stored auth and browser-like user agent", async (t) => {
  const tempRoot = await createTempDir("codexes-subscription-success");
  t.after(async () => removeTempDir(tempRoot));

  const account = createAccount(tempRoot);
  await writeAuthState(account, {
    accessToken: "synthetic-access-token",
    accountId: "auth-account-123",
  });

  const calls: Array<{ init: RequestInit | undefined; url: string }> = [];
  const { events, logger } = createTestLogger();

  const result = await resolveAccountSubscriptionExpiration({
    account,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ active_until: "2026-05-15T05:58:25Z" });
    },
    logger,
  });

  assert.deepEqual(result, {
    displayValue: "15.05.2026",
    isoValue: "2026-05-15T05:58:25.000Z",
    plan: null,
    source: "active_until",
  });
  assert.equal(calls.length, 1);

  const [call] = calls;
  assert.ok(call);
  const url = new URL(call.url);
  assert.equal(url.origin + url.pathname, "https://chatgpt.com/backend-api/subscriptions");
  assert.equal(url.searchParams.get("account_id"), "auth-account-123");

  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer synthetic-access-token");
  assert.match(headers.get("user-agent") ?? "", /^Mozilla\/5\.0 .*Chrome\/.* Safari\/537\.36$/);
  assert.equal(headers.has("cookie"), false);
  assert.equal(headers.has("origin"), false);
  assert.equal(headers.has("referer"), false);
  assert.equal(headers.has("OpenAI-Account-ID"), false);
  assert.equal(JSON.stringify(events).includes("synthetic-access-token"), false);
  assertEvent(events, "selection.subscription_expiration.resolve_start", "debug");
  assertEvent(events, "selection.subscription_expiration.http_complete", "debug");
  assertEvent(events, "selection.subscription_expiration.resolve_complete", "debug");
});

test("subscription client returns empty metadata for HTTP 403", async (t) => {
  const tempRoot = await createTempDir("codexes-subscription-403");
  t.after(async () => removeTempDir(tempRoot));

  const account = createAccount(tempRoot);
  await writeAuthState(account, {
    accessToken: "synthetic-access-token",
    accountId: "auth-account-123",
  });
  const { events, logger } = createTestLogger();

  const result = await resolveAccountSubscriptionExpiration({
    account,
    fetchImpl: async () => new Response("blocked", { status: 403 }),
    logger,
  });

  assert.deepEqual(result, emptyExpiration("http-error"));
  assertEvent(events, "selection.subscription_expiration.http_error", "debug");
});

test("subscription client returns empty metadata when auth is missing", async (t) => {
  const tempRoot = await createTempDir("codexes-subscription-missing-auth");
  t.after(async () => removeTempDir(tempRoot));

  const { events, logger } = createTestLogger();
  let fetchCalled = false;

  const result = await resolveAccountSubscriptionExpiration({
    account: createAccount(tempRoot),
    fetchImpl: async () => {
      fetchCalled = true;
      return jsonResponse({ active_until: "2026-05-15T05:58:25Z" });
    },
    logger,
  });

  assert.equal(fetchCalled, false);
  assert.deepEqual(result, emptyExpiration("auth-missing"));
  assertEvent(events, "selection.subscription_expiration.auth_missing", "debug");
});

test("subscription client returns empty metadata for invalid JSON", async (t) => {
  const tempRoot = await createTempDir("codexes-subscription-invalid-json");
  t.after(async () => removeTempDir(tempRoot));

  const account = createAccount(tempRoot);
  await writeAuthState(account, {
    accessToken: "synthetic-access-token",
    accountId: "auth-account-123",
  });
  const { events, logger } = createTestLogger();

  const result = await resolveAccountSubscriptionExpiration({
    account,
    fetchImpl: async () => new Response("{ not-json", { status: 200 }),
    logger,
  });

  assert.deepEqual(result, emptyExpiration("invalid-json"));
  assertEvent(events, "selection.subscription_expiration.invalid_json", "debug");
});

test("subscription client returns empty metadata when active_until is missing", async (t) => {
  const tempRoot = await createTempDir("codexes-subscription-missing-active-until");
  t.after(async () => removeTempDir(tempRoot));

  const account = createAccount(tempRoot);
  await writeAuthState(account, {
    accessToken: "synthetic-access-token",
    accountId: "auth-account-123",
  });
  const { events, logger } = createTestLogger();

  const result = await resolveAccountSubscriptionExpiration({
    account,
    fetchImpl: async () => jsonResponse({ plan_type: "plus" }),
    logger,
  });

  assert.deepEqual(result, emptyExpiration("active-until-missing", "plus"));
  assertEvent(events, "selection.subscription_expiration.active_until_missing", "debug");
});

test("subscription client keeps normalized plan metadata when active_until is missing", async (t) => {
  const tempRoot = await createTempDir("codexes-subscription-missing-active-until-plan");
  t.after(async () => removeTempDir(tempRoot));

  const account = createAccount(tempRoot);
  await writeAuthState(account, {
    accessToken: "synthetic-access-token",
    accountId: "auth-account-123",
  });
  const { events, logger } = createTestLogger();

  const result = await resolveAccountSubscriptionExpiration({
    account,
    fetchImpl: async () => jsonResponse({ plan_type: "FREE" }),
    logger,
  });

  assert.deepEqual(result, emptyExpiration("active-until-missing", "free"));
  assertEvent(events, "selection.subscription_expiration.active_until_missing", "debug");
});

test("subscription client returns empty metadata when active_until is invalid", async (t) => {
  const tempRoot = await createTempDir("codexes-subscription-invalid-active-until");
  t.after(async () => removeTempDir(tempRoot));

  const account = createAccount(tempRoot);
  await writeAuthState(account, {
    accessToken: "synthetic-access-token",
    accountId: "auth-account-123",
  });
  const { events, logger } = createTestLogger();

  const result = await resolveAccountSubscriptionExpiration({
    account,
    fetchImpl: async () => jsonResponse({ active_until: "not-a-date" }),
    logger,
  });

  assert.deepEqual(result, emptyExpiration("active-until-invalid"));
  assertEvent(events, "selection.subscription_expiration.active_until_invalid", "debug");
});

test("subscription client returns empty metadata for timeout or request failure", async (t) => {
  const tempRoot = await createTempDir("codexes-subscription-timeout");
  t.after(async () => removeTempDir(tempRoot));

  const account = createAccount(tempRoot);
  await writeAuthState(account, {
    accessToken: "synthetic-access-token",
    accountId: "auth-account-123",
  });
  const timeoutLogger = createTestLogger();
  const failureLogger = createTestLogger();

  const timeoutResult = await resolveAccountSubscriptionExpiration({
    account,
    fetchImpl: async () => {
      throw createNamedError("TimeoutError", "timed out");
    },
    logger: timeoutLogger.logger,
  });
  const failureResult = await resolveAccountSubscriptionExpiration({
    account,
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
    logger: failureLogger.logger,
  });

  assert.deepEqual(timeoutResult, emptyExpiration("timeout"));
  assert.deepEqual(failureResult, emptyExpiration("request-failed"));
  assertEvent(timeoutLogger.events, "selection.subscription_expiration.timeout", "debug");
  assertEvent(failureLogger.events, "selection.subscription_expiration.request_failed", "debug");
});

function createAccount(tempRoot: string): AccountRecord {
  return {
    authDirectory: path.join(tempRoot, "account-auth"),
    createdAt: "2026-04-21T00:00:00.000Z",
    id: "registry-account-1",
    label: "personal",
    lastUsedAt: null,
    updatedAt: "2026-04-21T00:00:00.000Z",
  };
}

async function writeAuthState(
  account: AccountRecord,
  input: {
    accessToken: string;
    accountId: string;
  },
): Promise<void> {
  await writeJson(path.join(account.authDirectory, "state", "auth.json"), {
    tokens: {
      access_token: input.accessToken,
      account_id: input.accountId,
    },
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function emptyExpiration(
  source: string,
  plan: string | null = null,
): {
  displayValue: null;
  isoValue: null;
  plan: string | null;
  source: string;
} {
  return {
    displayValue: null,
    isoValue: null,
    plan,
    source,
  };
}

function createNamedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
