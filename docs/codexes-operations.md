[Back to README](../README.md)

# codexes Operations Guide

## Summary

`codexes` wraps the real `codex` binary. It keeps one shared runtime home for stable CLI behavior and MCP continuity, then swaps in account-scoped auth state before every wrapped Codex launch.

## Installation

For local development:

```bash
npm install
npm run build
npm test
node dist/cli.js --help
```

For packaged installs:

```bash
npm run pack:tarball
npm install -g ./artifacts/codexes-<version>.tgz
```

## Account Lifecycle

Add an account:

```bash
codexes account add work
```

The add flow launches the real `codex login` process in an isolated workspace, captures the resulting file-backed auth state, and stores it under the new account profile.

List accounts:

```bash
codexes account list
```

Select the default account:

```bash
codexes account use work
```

Remove an account:

```bash
codexes account remove work
```

If an account profile becomes invalid, the safe repair flow is:

1. `codexes account remove <account-id-or-label>`
2. `codexes account add <label>`
3. `codexes account use <label>`

## Runtime Model

The wrapper separates runtime files into four classes:

- Shared: `config.toml`, `mcp.json`, `trust/`
- Account-scoped: `auth.json`, `sessions/`
- Ephemeral: caches, logs, history, temp files
- Protected: SQLite state and keyring-related artifacts

Only account-scoped files are activated into the shared Codex home before launching the real `codex` process. Shared files stay stable across accounts, which keeps MCP configuration and trust state consistent.

## MCP Continuity

MCP continuity is preserved by design:

- `mcp.json` lives in the shared runtime
- `trust/` lives in the shared runtime
- `config.toml` is shared and pinned to `cli_auth_credentials_store = "file"`

Switching accounts should not require rebuilding the MCP topology because the wrapper never replaces those shared artifacts during account activation.

## Concurrency Guarantees

`codexes` uses a runtime lock under the wrapper-owned runtime root before mutating the shared Codex home.

Current behavior:

- one process acquires the lock and proceeds
- other processes wait up to the configured timeout
- stale locks are detected and cleared based on lock age
- every successful run releases the lock on exit

If you see `runtime_lock.acquire.timeout`, inspect whether another wrapper process is still active before deleting any lock directory manually.

## Selection Strategies

Supported production strategies:

- `manual-default`: uses the selected default account
- `single-account`: auto-selects the only configured account

Experimental strategy:

- `remaining-limit-experimental`: probes `https://chatgpt.com/backend-api/wham/usage` for each configured account, normalizes the quota payload, then ranks usable accounts by:
  1. `dailyRemaining` descending
  2. `weeklyRemaining` descending
  3. current default account first
  4. stable registry order

Enable it explicitly:

```bash
CODEXES_ACCOUNT_SELECTION_STRATEGY=remaining-limit-experimental codexes chat
```

Optional knobs:

- `CODEXES_EXPERIMENTAL_SELECTION_TIMEOUT_MS`
- `CODEXES_EXPERIMENTAL_SELECTION_CACHE_TTL_MS`
- `CODEXES_EXPERIMENTAL_SELECTION_USE_ACCOUNT_ID_HEADER=1`

## Remaining-Limit Probe

The selector treats `wham/usage` as a best-effort signal. It is useful for routing between already configured accounts, but it is not a hard wrapper contract.

### Payload fields used for ranking

The normalizer accepts several response shapes and reads both top-level and nested quota windows:

| Field | Meaning |
|-------|---------|
| `allowed` | Whether the account is currently allowed to launch |
| `limit_reached` | Global exhausted flag when exposed by the endpoint |
| `daily.remaining` | Remaining daily headroom |
| `weekly.remaining` | Remaining weekly headroom |
| `daily.limit_reached` / `weekly.limit_reached` | Per-window exhausted flags |
| `reset_at` / `resets_at` / `next_reset_at` | Reset timestamp candidates |
| `percent_used` / `percentage_used` | Optional utilization hints |

The implementation also accepts `usage.daily`, `usage.weekly`, `quotas.daily`, and `quotas.weekly`. Missing `used` and `remaining` values are derived when the opposite side plus `limit` is present.

### Normalized snapshot

Each successful probe is normalized into:

- `dailyRemaining` and `weeklyRemaining`
- `dailyResetsAt` and `weeklyResetsAt`
- `dailyPercentUsed` and `weeklyPercentUsed`
- `status`: `usable`, `not-allowed`, `limit-reached`, or `missing-usage-data`
- `statusReason`: human-readable explanation for logs and fallback analysis

Only snapshots with `status = usable` participate in ranking.

### Ranking behavior

The selection code compares usable accounts in this order:

1. Higher `dailyRemaining`
2. Higher `weeklyRemaining`
3. Current default account
4. Stable registry order

This means an account with more daily headroom wins even if another account has better weekly headroom. Weekly remaining is only used as the tie-breaker after daily remaining matches.

### Fallback contract

`codexes` falls back to `manual-default` when probing cannot produce a reliable winner:

- all probes fail
- some probes succeed and some fail
- the payload shape is malformed or missing both daily and weekly remaining values
- every probed account is exhausted
- every successful snapshot is ambiguous rather than usable

The fallback is deliberate. The wrapper prefers a predictable default over making a weak routing decision from partial quota data.

### Cache and request headers

The selector stores normalized snapshots in a short-lived cache controlled by `CODEXES_EXPERIMENTAL_SELECTION_CACHE_TTL_MS`. When `CODEXES_EXPERIMENTAL_SELECTION_USE_ACCOUNT_ID_HEADER=1` is enabled and the saved auth state exposes an account id, probes include `OpenAI-Account-ID` to disambiguate which account is being measured.

### Test coverage

The remaining-limit path is covered by automated tests for:

- ranking by daily then weekly remaining usage
- cache reuse without refetching
- mixed success and timeout outcomes
- missing and malformed auth state
- fully exhausted accounts
- invalid response payloads and corrupt cache files
- root command launch with experimentally selected account activation

## Logging

Structured logs are written to stderr. Use `LOG_LEVEL=DEBUG` when investigating wrapper behavior:

```bash
LOG_LEVEL=DEBUG codexes login status
```

Expected log properties:

- event names are stable and namespaced
- auth tokens and other raw secrets are not logged
- runtime paths, selector decisions, lock behavior, and spawn failures are logged with context

Useful events:

- `wrapper_config.resolved`
- `wrapper_config.experimental_selection_resolved`
- `runtime_init.complete`
- `registry.account_selected`
- `selection.experimental_enabled`
- `selection.experimental_ranked`
- `selection.experimental_selected`
- `selection.usage_probe.success`
- `selection.usage_cache.hit`
- `selection.experimental_fallback_all_probes_failed`
- `selection.experimental_fallback_mixed_probe_outcomes`
- `selection.experimental_fallback_all_accounts_exhausted`
- `selection.experimental_fallback_ambiguous_usage`
- `runtime_lock.acquire.timeout`
- `account_activation.missing_auth`
- `spawn_codex.complete`

## Troubleshooting

### Unsupported credential store

Symptoms:

- `credential_store.unsupported`
- `codexes account add requires cli_auth_credentials_store = "file"`

Fix:

1. Open the shared Codex config file.
2. Set `cli_auth_credentials_store = "file"`.
3. Retry the wrapper command.

### Missing or broken account auth

Symptoms:

- `account_activation.missing_auth`
- `command.auth_missing_after_login`

Fix:

1. Remove the broken account profile.
2. Re-add the account through `codexes account add`.
3. Re-select it with `codexes account use`.

### Shared runtime lock timeout

Symptoms:

- `runtime_lock.acquire.timeout`

Fix:

1. Confirm whether another `codexes` process is still running.
2. Wait for the active process to exit.
3. If the lock is stale, clear it only after inspection.

### No default account selected

Symptoms:

- `selection.manual_default_missing`

Fix:

```bash
codexes account use <account-id-or-label>
```

### Experimental selector HTTP or auth failures

Symptoms:

- `selection.usage_probe.http_error`
- `selection.usage_probe.timeout`
- `selection.usage_probe.auth_missing`
- `selection.account_auth_state.malformed_json`
- `selection.experimental_fallback_all_probes_failed`

Fix:

1. Confirm the account profile still has `state/auth.json` with a current `access_token`.
2. Retry with `LOG_LEVEL=DEBUG` to inspect per-account probe status, cache hits, and fallback reason.
3. Re-add any account whose stored auth state is missing or malformed.
4. If the endpoint is timing out, increase `CODEXES_EXPERIMENTAL_SELECTION_TIMEOUT_MS` or switch back to `manual-default`.

### Unexpected experimental fallback

Symptoms:

- `selection.experimental_fallback_mixed_probe_outcomes`
- `selection.experimental_fallback_all_accounts_exhausted`
- `selection.experimental_fallback_ambiguous_usage`

Fix:

1. Check whether the configured accounts are expected to have current usage headroom.
2. Inspect `selection.experimental_ranked` and `selection.usage_probe.success` at `LOG_LEVEL=DEBUG`.
3. If the usage payload is incomplete or unreliable for your environment, keep using `manual-default` until the endpoint behavior is understood.

### Real Codex binary not found

Symptoms:

- `command.binary_missing`
- `binary_resolution.missing`

Fix:

1. Ensure the real `codex` executable is installed.
2. Ensure it is available on `PATH`.
3. Re-run the wrapper command.

## See Also

- [README](../README.md) - project landing page and quick start
- [Auth State Spike](research/auth-state-spike.md) - research notes about stored auth state behavior
- [Process Notes](../src/process/README.md) - details about launching the real `codex` process
