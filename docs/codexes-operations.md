[Back to README](../README.md)

# codexes Operations Guide

## Summary

`codexes` wraps the real `codex` binary. Он использует основную `~/.codex` как единственный shared source of truth, а для каждого аккаунта держит стабильную `accounts/<account>/state/codex-home`, состоящую из ссылок на shared home и отдельной ссылки `auth.json` на `accounts/<account>/state/auth.json`.

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

Wrapper разделяет runtime files на такие классы:

- Shared: `config.toml`, `mcp.json`, `trust/`, `sessions/`, `history.jsonl`, sqlite state, caches и остальные общие Codex artifacts
- Account-scoped: только `auth.json`
- Ephemeral: временные файлы, которые можно пересоздать локально
- Protected: `keyring/**` и прочие unsupported credential-store artifacts

Для wrapped-запуска `CODEX_HOME` указывает на `accounts/<account>/state/codex-home`. Эта папка переиспользуется при повторном открытии терминала для того же аккаунта. Внутри неё shared artifacts подключены ссылками напрямую на основную `~/.codex`; для файлов используется `symlink` с fallback на `hardlink`, для директорий на Windows используется `junction`. `auth.json` всегда является прямой ссылкой на `accounts/<account>/state/auth.json`. Полная копия Codex home больше не создаётся, а каждый запуск делает reconcile: создаёт недостающие ссылки, чинит неправильные и удаляет stale entries, которых уже нет в shared source.

## MCP Continuity

MCP continuity сохраняется через ссылки:

- `mcp.json` берётся из основной `~/.codex` и подключается в account home live-ссылкой
- `trust/` берётся из основной `~/.codex` и подключается в account home live-ссылкой
- `config.toml` берётся из основной `~/.codex` как есть; wrapper больше не держит snapshot и не переписывает файл при инициализации

Switching accounts не требует rebuilding MCP topology: новые MCP и изменения `config.toml` из основной `.codex` видны уже созданным account home без копирования и повторной инициализации.

## Project Root And Trust Warnings

The wrapped `codex` child always launches from the caller's current working directory. `codexes` records that active workspace as `projectRoot` during runtime initialization, but shared `config.toml` now stays linked to the main `~/.codex` without wrapper-side sanitizing.

Current behavior:

- project-local `.codex` hooks и trust-пути читаются ровно так, как они определены в основной `~/.codex/config.toml`
- если в основной конфигурации остались stale absolute paths из другого репозитория, их нужно исправлять в самой `~/.codex/config.toml`
- DEBUG logs по linked-home flow идут через `runtime_init.path_model`, `workspace_reconcile.shared_entry_ready`, `workspace_reconcile.auth_entry_ready` и `workspace_reconcile.complete`

If Codex warns that project-local config, hooks, or exec policies are disabled for a different repository, run the wrapper with `LOG_LEVEL=DEBUG` and verify which main `~/.codex` file is linked into the current account home.

## Concurrency

`codexes` больше не ставит runtime lock перед созданием терминала.

Current behavior:

- новый терминал создаётся без ожидания lock acquisition
- несколько аккаунтов могут работать параллельно, потому что у каждого свой `auth.json`, но shared `.codex` у них общий
- несколько терминалов одного аккаунта используют одну и ту же стабильную account home
- DEBUG diagnostics для home layout: `execution_workspace.account_home_resolved`, `workspace_reconcile.shared_entry_ready`, `workspace_reconcile.auth_entry_ready`, `workspace_reconcile.complete`

Событий вида `runtime_lock.acquire.timeout`, `account_sync_lock.acquire.timeout`, `lock acquisition` и `lock release` в нормальном запуске быть не должно.

## Selection Strategies

Default strategy:

- `remaining-limit`: probes `https://chatgpt.com/backend-api/wham/usage` for each configured account, normalizes the quota payload, then ranks usable accounts by:
  1. primary-window remaining percent descending
  2. secondary-window remaining percent descending
  3. current default account first
  4. stable registry order

Compatibility overrides:

- `manual-default`: uses the selected default account
- `single-account`: auto-selects the only configured account

```bash
codexes chat
```

Use `CODEXES_ACCOUNT_SELECTION_STRATEGY` only when you need to override the default behavior:

```bash
CODEXES_ACCOUNT_SELECTION_STRATEGY=manual-default codexes chat
```

Backward compatibility:

- `remaining-limit-experimental` is still accepted as a legacy alias for `remaining-limit`

Optional knobs:

- `CODEXES_EXPERIMENTAL_SELECTION_TIMEOUT_MS`
- `CODEXES_EXPERIMENTAL_SELECTION_CACHE_TTL_MS`
- `CODEXES_EXPERIMENTAL_SELECTION_USE_ACCOUNT_ID_HEADER=1`

## Remaining-Limit Probe

The selector treats `wham/usage` as a best-effort signal. It is useful for routing between already configured accounts, but it is not a hard wrapper contract.

## User-Facing Summary Output

Before `codexes` launches the real `codex` binary, the CLI prints a compact English execution summary:

- every configured account
- the normalized usage status (`usable`, `limit-reached`, `not-allowed`, `missing-usage-data`, or `probe-failed`)
- primary remaining percent
- secondary remaining percent
- data source: `fresh`, `cache`, or `unavailable`
- the selected account and the selection mode that produced it

Each account renders on one compact line. In TTY mode the formatter adds ANSI color for tags, statuses, and source markers. In non-interactive output the formatter emits the same content without ANSI sequences.

When you run `codexes account list`, the CLI now renders a dedicated display-only table instead of reusing the execution-line formatter. The table keeps the same diagnostics, but presents them in explicit columns:

- `Label`
- `Account ID`
- `Flags` (`selected`, `default`, `rank #...`)
- `Status`
- `5h`
- `Weekly`
- `Plan`
- `Source`
- `Detail`

The table keeps ASCII borders in both TTY and non-TTY output so alignment stays stable in logs and pasted terminal output. In TTY mode, status and quota cells still receive ANSI color. Footer lines under the table continue to announce `Selected account`, `Fallback`, and `Execution note` details.

When remaining-limit probing cannot produce a reliable winner, the CLI prints an explicit fallback line. Typical fallback messages cover:

- every probe failing
- mixed probe outcomes
- all accounts being exhausted
- incomplete or ambiguous quota payloads

`fresh` means the account was probed during the current command. `cache` means the CLI reused a still-valid cached snapshot from the short-lived selection cache.

For `codexes account list`, the summary is display-only. If fallback analysis cannot resolve a valid execution account and there is no default account to fall back to, the command still renders the diagnostic table, prints `Selected account: unavailable for execution.`, and includes an `Execution note:` line explaining why launch would be blocked.

For wrapped execution commands such as `codexes chat`, the contract stays strict and compact: no account is launched unless the selector resolves a concrete execution winner, and the wrapped launch path does not switch to the table layout.

### Payload fields used for ranking

The normalizer now treats the `rate_limit` payload as the primary contract and keeps the legacy shapes as compatibility fallbacks:

| Field | Meaning |
|-------|---------|
| `rate_limit.allowed` | Whether the account is currently allowed to launch |
| `rate_limit.limit_reached` | Global exhausted flag when exposed by the endpoint |
| `rate_limit.primary_window.used_percent` | Used percent for the short window; ranked as the primary signal after conversion to remaining percent |
| `rate_limit.secondary_window.used_percent` | Used percent for the long window; ranked as the secondary signal after conversion to remaining percent |
| `rate_limit.*_window.reset_at` / `reset_after_seconds` | Reset timestamp candidates |
| `rate_limit.*_window.limit_window_seconds` | Window-size metadata for diagnostics |
| `daily.remaining` / `weekly.remaining` | Legacy fallback shapes still accepted for backward compatibility |

The implementation still accepts `usage.daily`, `usage.weekly`, `quotas.daily`, and `quotas.weekly`. Missing `used` and `remaining` values are derived when the opposite side plus `limit` is present, and string `used_percent` values are parsed and clamped into the `0..100` range before ranking.

### Normalized snapshot

Each successful probe is normalized into:

- `dailyRemaining` and `weeklyRemaining` as remaining percent values
- `dailyResetsAt` and `weeklyResetsAt`
- `dailyPercentUsed` and `weeklyPercentUsed`
- `status`: `usable`, `not-allowed`, `limit-reached`, or `missing-usage-data`
- `statusReason`: human-readable explanation for logs and fallback analysis

Only snapshots with `status = usable` participate in ranking. A usable snapshot can still be excluded from automatic execution if the companion subscription metadata says the account is already expired or the resolved plan is outside the paid allow-list.

### Ranking behavior

The selection code compares usable accounts in this order:

1. Higher primary-window remaining percent
2. Higher secondary-window remaining percent
3. Current default account
4. Stable registry order

This means an account with more primary-window headroom wins even if another account has better secondary-window headroom. Secondary remaining is only used as the tie-breaker after the primary remaining percentages match.

### Fallback contract

`codexes` falls back to `manual-default` when probing cannot produce a reliable winner:

- all probes fail
- some probes succeed and some fail
- the payload shape is malformed or missing both daily and weekly remaining values
- every probed account is exhausted
- every successful snapshot is ambiguous rather than usable
- the fallback/default account is blocked by subscription expiration or by a `free` plan

The fallback is deliberate. The wrapper prefers a predictable default over making a weak routing decision from partial quota data.

### Cache and request headers

The selector stores normalized snapshots in a short-lived cache controlled by `CODEXES_EXPERIMENTAL_SELECTION_CACHE_TTL_MS`. When `CODEXES_EXPERIMENTAL_SELECTION_USE_ACCOUNT_ID_HEADER=1` is enabled and the saved auth state exposes an account id, probes include `OpenAI-Account-ID` to disambiguate which account is being measured. The environment variable names keep the older `EXPERIMENTAL` prefix for compatibility, even though the flow is now the default path.

### Test coverage

The remaining-limit path is covered by automated tests for:

- ranking by primary then secondary remaining percent
- cache reuse without refetching
- the real `rate_limit.primary_window` / `secondary_window` payload shape
- mixed success and timeout outcomes
- missing and malformed auth state
- fully exhausted accounts
- subscription metadata that blocks expired or `free` fallback accounts
- invalid response payloads and corrupt cache files
- display-only account-list table rendering in plain and TTY modes
- execution summary regression coverage to prevent table formatting from leaking into wrapped launches
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

The human-readable account summary is regular CLI output on stdout. Structured logs are suppressed from normal CLI stderr by default; set `LOG_LEVEL=DEBUG` when you need the raw diagnostic event stream. Regular stderr should therefore stay reserved for controlled top-level error messages.

Useful events:

- `wrapper_config.resolved`
- `wrapper_config.experimental_selection_resolved`
- `runtime_init.complete`
- `registry.account_selected`
- `selection.experimental_enabled`
- `selection.experimental_ranked`
- `selection.experimental_selected`
- `selection.experimental_fallback_selected`
- `selection.usage_probe.success`
- `selection.usage_cache.hit`
- `selection.usage_normalize.percent_resolved`
- `selection.usage_normalize.percent_clamped`
- `selection.usage_normalize.status_usable`
- `selection.experimental_fallback_all_probes_failed`
- `selection.experimental_fallback_mixed_probe_outcomes`
- `selection.experimental_fallback_all_accounts_exhausted`
- `selection.experimental_fallback_ambiguous_usage`
- `selection.display_only_missing_execution_account`
- `selection.execution_blocked_missing_default`
- `selection.summary.start`
- `selection.summary.complete`
- `selection.format_summary.start`
- `selection.format_summary.complete`
- `root.summary_rendered`
- `root.selected_account_announced`
- `root.fallback_announced`
- `account_list.summary_rendered`
- `account_list.fallback_announced`
- `account_activation.missing_auth`
- `execution_workspace.account_home_resolved`
- `workspace_reconcile.shared_entry_ready`
- `workspace_reconcile.auth_entry_ready`
- `workspace_reconcile.complete`
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

### Account home links are not visible

Symptoms:

- `workspace_reconcile.source_scan_failed`
- expected MCP changes from shared `.codex/config.toml` are not visible in an account home

Fix:

1. Re-run with `LOG_LEVEL=DEBUG`.
2. Check `execution_workspace.account_home_resolved` for the active `codexHome`.
3. Check `workspace_reconcile.shared_entry_ready` for `config.toml`, `mcp.json`, `trust/` and `sessions/`.

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
4. If the endpoint is timing out, increase `CODEXES_EXPERIMENTAL_SELECTION_TIMEOUT_MS` or temporarily override the strategy with `CODEXES_ACCOUNT_SELECTION_STRATEGY=manual-default`.

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

## Troubleshooting

### Repeated trust prompt for the same project

If `codex` keeps asking `Do you trust the contents of this directory?` for a project you already trusted, verify that you are still launching through the same shared `CODEX_HOME`. Recent versions no longer do delayed shared sync: `trust/` is linked directly to the main `~/.codex`, so repeated prompts usually mean the shared source itself is missing or the account home link tree needs reconcile diagnostics.

### Unexpected `read-only` mode

`codexes` forwards the original launch argv to the real `codex` process and now logs the resolved `sandbox` and `approval` policy in DEBUG output together with the inherited working directory. If another tool launches `codexes`, inspect those DEBUG fields first to confirm the upstream caller is still passing the expected `--sandbox` and approval flags.
