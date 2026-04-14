# codexes

> Transparent multi-account wrapper for the real `codex` CLI.

`codexes` keeps one shared Codex runtime for config, MCP wiring, and trust state while storing each account's auth material in its own profile. Before every wrapped launch it activates the selected profile, so you can switch accounts without rebuilding the rest of the runtime.

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

- Shared `CODEX_HOME` for stable `config.toml`, `mcp.json`, and `trust/`
- Per-account auth activation for `auth.json` and `sessions/`
- Runtime locking to avoid concurrent mutation of the shared Codex home
- Experimental account selection by remaining primary and secondary window percentages
- Packaged npm distribution with smoke coverage for real installs

## Example

```bash
codexes account add work
codexes account add personal
codexes account use work
codexes chat --model gpt-5
```

By default, `codexes` uses the `remaining-limit` selector. It probes `https://chatgpt.com/backend-api/wham/usage`, reads `rate_limit.primary_window` and `rate_limit.secondary_window`, converts `used_percent` into remaining percent, and picks the best usable account before launching the real `codex` binary.

If you need compatibility overrides, set `CODEXES_ACCOUNT_SELECTION_STRATEGY` to `manual-default`, `single-account`, or `remaining-limit`. The legacy value `remaining-limit-experimental` is still accepted for backward compatibility.

Before launch, `codexes` prints an English account selection summary that includes every configured account, its current status, primary and secondary remaining percent, whether the data came from `fresh` probing or `cache`, and which account was selected. In interactive terminals the account lines are colorized; in plain-text contexts the same output stays ANSI-free. If probing is incomplete or unreliable, the CLI prints an explicit fallback message instead of silently behaving like `manual-default`.

`codexes account list` uses the same summary formatter, but stays diagnostic and read-only. When fallback analysis cannot produce a reliable execution winner and no valid default account is available, `account list` still renders the account table plus an execution note instead of failing. Wrapped execution commands remain strict and still require a concrete selected account before launch.

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
