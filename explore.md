# Explore Snapshot: Subscription Acquisition Date Column

Created: 2026-04-18

## Goal

Add a separate column to the account limits table that shows the account subscription acquisition date in `dd.mm.yyyy` format.

## What Was Verified

- The limits table for `codexes account list` is rendered through `formatSelectionSummary(...)` in `src/selection/format-selection-summary.ts`.
- Current display-table columns are `Label`, `Account ID`, `Flags`, `Status`, `5h`, `Weekly`, `Plan`, `Source`, and `Detail`.
- `AccountRecord` in `src/accounts/account-registry.ts` stores only wrapper-local timestamps such as `createdAt`, `updatedAt`, and `lastUsedAt`.
- `createdAt` is the date the account was added to `codexes`, not the date the subscription was purchased.
- The normalized `wham/usage` payload currently covers limits, plan, status, and reset metadata, but no verified subscription acquisition date field is modeled in `src/selection/usage-types.ts` or `src/selection/usage-normalize.ts`.
- Per-account metadata already exists in `account.json` and is written by `src/commands/account-add/run-account-add-command.ts`.

## Key Constraint

There is no confirmed source of truth for the real subscription acquisition date in the current codebase.

## Viable Data Sources

1. Real date from an upstream API response.
2. Locally stored subscription date in per-account `account.json`.
3. Wrapper-local `AccountRecord.createdAt` if the requirement is actually "date added to codexes".

## Recommended Direction

- Source of truth is the optional per-account `subscriptionAcquiredAt` field in `account.json`.
- `AccountRecord.createdAt` remains the wrapper-local "added to codexes" timestamp and must not be reused for subscription acquisition.
- Upstream probing remains unmodified until a verified billing/subscription date field is discovered in a real payload.
- Render the final value as `dd.mm.yyyy`; render `-` when the date is unknown.

## Affected Areas

- `src/selection/usage-types.ts`
- `src/selection/usage-normalize.ts`
- `src/selection/selection-summary.ts`
- `src/selection/format-selection-summary.ts`
- `src/selection/render-selection-summary-table.ts`
- `src/accounts/account-registry.ts` or per-account `account.json` readers, depending on chosen source
- `test/account-list.test.ts`

## Open Question

Does "date of subscription acquisition" mean the real billing/subscription start date from OpenAI, or is a locally managed date acceptable?
