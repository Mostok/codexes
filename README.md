# codexes

> Transparent multi-account wrapper for the real `codex` CLI.

`codexes` держит для каждого аккаунта стабильную `accounts/<account>/state/codex-home`, но не клонирует в неё всю home. При запуске выбранный account home переиспользуется: shared entries подключаются ссылками напрямую на основную `~/.codex`, а account-scoped `auth.json` и `sessions/` каждый раз заново подставляются из `accounts/<account>/state`. Изменения в основной `.codex/config.toml`, `mcp.json` и `trust/` становятся видны уже созданным account home без повторной инициализации.

## Quick Start

```bash
npm install
npm run build
npm test
node dist/cli.js --help
```

Install the current checkout globally and use `codexes` from any terminal:

```bash
npm install -g .
codexes --help
```

Install the public package from anywhere:

```bash
npm install -g @mostok/codexes
codexes --help
```

## Key Features

- Стабильный per-account `CODEX_HOME`, который переиспользуется между терминалами одного аккаунта
- Общие `config.toml`, `mcp.json`, `trust/` и другие shared Codex-файлы подключаются ссылками напрямую на основную `~/.codex`
- `auth.json` и `sessions/` остаются account-scoped и не шарятся между аккаунтами
- Изолированный account `auth.json` без клонирования всей Codex home
- Shared `trust/` сохраняется даже после неуспешного завершения child-процесса
- Нет runtime lock gate перед созданием терминала
- Experimental account selection by remaining primary and secondary window percentages
- Packaged npm distribution with smoke coverage for real installs

## Example

```bash
codexes account add work
codexes account add personal --paid-at 18.04.2026
codexes account set-paid-at work 20.04.2026
codexes account use work
codexes chat --model gpt-5
```

By default, `codexes` uses the `remaining-limit` selector. It probes `https://chatgpt.com/backend-api/wham/usage`, reads `rate_limit.primary_window` and `rate_limit.secondary_window`, converts `used_percent` into remaining percent, and picks the best usable account before launching the real `codex` binary. The selector also reads subscription metadata from `https://chatgpt.com/backend-api/subscriptions` and excludes accounts whose `active_until` timestamp is already in the past or whose resolved subscription plan is `free`.

If you need compatibility overrides, set `CODEXES_ACCOUNT_SELECTION_STRATEGY` to `manual-default`, `single-account`, or `remaining-limit`. The legacy value `remaining-limit-experimental` is still accepted for backward compatibility. The same subscription eligibility rule applies across all strategies: a `free` plan or an `active_until` timestamp that is already in the past makes the account unavailable for execution.

Before launch, `codexes` prints a compact English execution summary that includes every configured account, its current status, primary and secondary remaining percent, whether the data came from `fresh` probing or `cache`, and which account was selected. In interactive terminals the execution summary stays colorized; in plain-text contexts it stays ANSI-free. If probing is incomplete or unreliable, the CLI prints an explicit fallback message instead of silently behaving like `manual-default`. User-facing CLI failures stay sanitized by default as well: raw stack traces, internal module noise, and filesystem paths remain in diagnostics only and are not emitted as normal terminal output unless you explicitly re-run with `LOG_LEVEL=DEBUG`.

`codexes account add` accepts an optional `--paid-at dd.mm.yyyy` flag. The value is normalized to ISO in `account.json` and shown in `codexes account list` under the `Payed at` column. If you need to change that stored date later, use `codexes account set-paid-at <account-id-or-label> <dd.mm.yyyy>`.

`codexes account list` now uses a dedicated diagnostic table with columns for label, account id, `Payed at`, flags, status, remaining percentages, plan, and source. Footer lines under the table still carry `Selected account`, `Fallback`, and `Execution note` diagnostics, so the command remains read-only and informative even when no execution winner exists. Wrapped execution commands remain strict and still use the compact summary contract before launch.

Для wrapped-запусков `codexes` сохраняет текущую рабочую директорию вызывающего терминала и пишет resolved `sandbox` / `approval` policy в DEBUG output. Runtime initialization также пишет `execution_workspace.account_home_resolved`, `login_workspace.shared_link.created`, `login_workspace.shared_link.exists`, `login_workspace.account_file_refreshed` и `login_workspace.account_directory_refreshed`, чтобы reuse account home и live links на основную `.codex` можно было диагностировать без ручного обхода файловой системы. Если child-сессия `codex` завершается с non-zero code, wrapper сохраняет shared linked artifacts только для `trust/**`, пропускает account sync-back и очищает account-scoped state из стабильного `codex-home`.

## Documentation

| Guide | Description |
|-------|-------------|
| [Operations Guide](docs/codexes-operations.md) | Runtime model, account lifecycle, remaining-limit selection, logs |

## Install

Local development:

```bash
npm run build
npm test
```

Packaged tarball:

```bash
npm run pack:tarball
npm run smoke:packaged
```

The generated package is written to `artifacts/` and can be installed with `npm install -g ./artifacts/mostok-codexes-<version>.tgz`.

## Publish

Publish to npmjs from your machine:

```bash
export NPM_TOKEN=YOUR_NPM_AUTOMATION_TOKEN
npm ci
npm test
npm publish --access public
```

Or create a GitHub release and let `.github/workflows/publish-npm.yml` publish the package through npm trusted publishing via GitHub OIDC.

## License

ISC
