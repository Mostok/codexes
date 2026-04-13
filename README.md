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
- Experimental account selection by remaining daily and weekly limits
- Packaged npm distribution with smoke coverage for real installs

## Example

```bash
codexes account add work
codexes account add personal
codexes account use work
CODEXES_ACCOUNT_SELECTION_STRATEGY=remaining-limit-experimental codexes chat --model gpt-5
```

The experimental selector probes `https://chatgpt.com/backend-api/wham/usage`, compares remaining quota windows, and picks the best usable account before launching the real `codex` binary.

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
