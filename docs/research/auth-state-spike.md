# Codex Auth State Spike

Date: 2026-04-13
Environment: Windows (`win32`), `codex-cli 0.117.0`
Probe command: `npm run probe:auth-state`

## Goal

Determine whether account switching for `codexes` can rely on `auth.json` alone, or whether SQLite and other runtime files also need per-account isolation.

## Observed local `~/.codex` layout

Top-level auth-related artifacts observed in `E:\Users\Daniil\.codex`:

- `auth.json`
- `config.toml`
- `sessions/**`
- `state_5.sqlite`, `state_5.sqlite-shm`, `state_5.sqlite-wal`
- `logs_1.sqlite`, `logs_1.sqlite-shm`, `logs_1.sqlite-wal`
- `history.jsonl`
- `models_cache.json`

`config.toml` does not explicitly set `cli_auth_credentials_store`. The probe therefore observed:

- Explicit credential-store config: `missing`
- Artifact inference: `file-artifacts-present`

This means the current installation behaves like a file-backed auth home, but the file-backed mode is not pinned in config.

## Probe scenarios

### Scenario 1: Full cloned home

Setup:

- Clone the current `~/.codex` into a temporary `CODEX_HOME`
- Run `codex login status`

Result:

- Exit code: `0`
- Output: `Logged in using ChatGPT`
- No content changes were detected in `auth.json`, `sessions/**`, `state_*.sqlite*`, or `logs_*.sqlite*`
- Only transient launcher files were created under `tmp/arg0/...`

### Scenario 2: Auth-only home

Setup:

- Create a clean temporary `CODEX_HOME`
- Copy only `auth.json` and `config.toml`
- Run `codex login status`

Result:

- Exit code: `0`
- Output: `Logged in using ChatGPT`
- No changes to `auth.json` or `config.toml`
- Only transient launcher files were created under `tmp/arg0/...`

## Conclusion

For the observed Windows installation, `auth.json` plus `config.toml` is sufficient for `codex login status`. That is enough evidence to treat `auth.json` as the primary account-owned artifact for read-only login inspection.

It is not enough evidence to treat SQLite state as safely shareable or mergeable:

- `state_*.sqlite*` and `logs_*.sqlite*` exist in the real Codex home
- The status probe did not mutate them
- No interactive `codex login` or token-refresh flow was exercised in this spike

Therefore the safe MVP conclusion is:

- Account-scoped: `auth.json`, `sessions/**`
- Shared: `config.toml`, `mcp.json`, `trust/**`
- Ephemeral: `cache/**`, `tmp/**`, `history.jsonl`, `models_cache.json`
- Protected until proven safe: `state_*.sqlite*`, `logs_*.sqlite*`, `keyring/**`

## Wrapper guidance

- Do not require SQLite files for basic account detection or `login status` style validation.
- Do not copy or merge SQLite files across accounts yet.
- Keep unsupported credential-store modes (`keyring`, `auto`) rejected for MVP.
- Consider requiring `cli_auth_credentials_store = "file"` explicitly before production switching, because the current installation works without the config key but that behavior is not pinned by configuration.

## POSIX assumption

The file naming and auth artifacts look platform-neutral, so a POSIX install will likely expose the same `auth.json`-centric login status behavior. That is still an assumption. Before shipping multi-platform account switching, run the same probe on at least one POSIX environment and verify:

- actual data-root location
- whether `login status` still succeeds with only `auth.json` + `config.toml`
- whether SQLite or session files mutate during interactive login and token refresh
