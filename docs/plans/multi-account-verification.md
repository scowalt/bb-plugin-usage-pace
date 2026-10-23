# Multi-account verification — 0.4.0 and 0.4.1

## 0.4.0 automated checks

- TypeScript check passed.
- 363 Vitest tests and all 3 token-total tests passed.
- Comment policy passed with zero violations; all 13 policy regression tests passed.
- BB 0.44.0 / SDK 0.5.29 built all committed artifacts. `check:release` passed with the npm 11.16.0 version declared by that BB distribution: isolated production-only source rebuild, version/SDK metadata, host digest, and backend/host loading.
- CLI schema tests require `accounts`, `pools`, the deprecated identical `providers` alias, account identities/locations/timestamps, and each window's nullable pace.

Regressions cover issued-identity merging across sources and hosts, non-merging null keys and identical emails, freshest measurements, explicit/legacy window kinds, source failures and five-second timeouts, three-request concurrency, discovery caching, login changes, weighted pool math including newly started windows, partial pools, overage, model-family restrictions, and account/pool reset countdowns.

A stale-zero regression prevents old zero-percent measurements appearing as currently available quota in either strip or dialog. CLI text also suppresses stale percentages; JSON preserves historical values marked stale.

Card tests use current account-section markup with two accounts and different weekly resets. The request regression requires plural, nonempty `providerIds`. Unknown account sections and unmatched machines draw no annotation. Saved-reset tests match Claude profile UUIDs and Codex account IDs, including two accounts with identical emails, and hide unread/unverified inventories.

## Earlier read-only live checks

Using the running BB instance and CLI 0.46.0, the actual collector read its discovered provider sources without installing or reloading the changed plugin. It merged one Codex identity reported by three hosts into one account, preserved a readable Claude account with three windows, kept unknown/expired identities separate, and isolated an existing OpenCode subscription-read error. No reset inventory was requested or redeemed.

The canonical browser RPC route `/api/v1/plugins/bb--provider-usage/rpc/getUsage` returned HTTP 200 with the plural provider-ID request; the unprefixed `provider-usage` route returned HTTP 404.

## 0.4.0 browser fixtures

A temporary, isolated browser fixture rendered the actual components and compiled CSS with synthetic accounts and a host-style preflight. It showed three Claude rows, one pool, and only the matching account's saved-reset badge. At container widths 172, 212, and 252px, every button had positive dimensions and none overflowed horizontally. Opening details showed the pool before accounts, source/host availability, observation age, per-window pace, and read-only resets. The responsive dialog at 375px fit the viewport without horizontal overflow and retained all three accounts. Browser sessions were closed; no development server was started.

This checks component layout and matching, not installation into the user's current BB theme or a live shared-source card.

## Completed 0.4.0 live check — 2026-10-23

The user completed the previously outstanding check on bb 0.46.1 / plugin SDK 0.6.49, with Claude Accounts serving a Max 20x login and a Pro login. The server host and laptop both reported the Max login through `provider-claude-code`. These are user-reported live observations, not a claim that 0.4.1 has been installed or checked live.

Passed:

- **Account merging:** the Max account merged across Claude Accounts and `provider-claude-code` on both machines into one account. The Pro account came from Claude Accounts alone.
- **Pool row:** `2/2 available · W 0.4× pace · 20% used (est.)`, matching a hand calculation from the two weekly windows with weights 20 and 1.
- **CLI:** text printed the pool first. JSON contained `accounts[]`, `pools[]`, and an identical `providers[]` alias, with nullable pace. The exit code was 0; `--tokens` and `--resets` behaved as before.
- **Strip and dialog:** both accounts and the pool rendered. Only the account whose login was on the server host showed a saved-reset badge.
- **Card route:** `/api/v1/plugins/bb--provider-usage/rpc/getUsage` returned HTTP 200; the unprefixed `provider-usage` route returned 404.
- **Card ticks:** both accounts in the Claude Accounts group had ticks at their own windows' even-pace positions. Ticks also drew in the per-machine view, including Codex.

## Live problems and 0.4.1 fixes

| # | Observed in 0.4.0 | Fix and regression evidence |
| --- | --- | --- |
| 1 | An OpenCode account error set `serverHostError`, hiding healthy machine-scoped Codex and Claude accounts in server-only mode. | Remove account/source errors from host availability. `server.test.ts` exercises the real collector → `getServerScope` → `usageForDisplay` path for an error usage state, a rejected `getResource`, and a rejected `listResources` after a successful inventory. Healthy server-local and shared rows remain; only affected rows are stale. Unknown, missing, offline, and unreadable-host-list tests remain. |
| 2 | The same account error appeared again in the dialog footer and a CLI `warning:` line. | Only discovery, host-list, and source-list failures populate snapshot `error`. Tests require null global error and no CLI warning for individual resource failures, while source-list warnings remain visible even in server-only mode. Resource timeouts remain account-local. |
| 3 | “Couldn’t refresh. Showing last update. Retry” appeared on healthy card tabs despite a correctly marked OpenCode tab. | Extend the notice matcher. DOM tests use the exact strings “Couldn’t load usage.”, “Couldn’t refresh usage.”, and “Couldn’t refresh. Showing last update.”, plus older wording. Only the failed tab shows the known failure; Codex, Claude Code, and All accounts stay clear. Tests identify failures from account `status`/`stale` without a host/global error. |
| 4 | The merged Max account's strip description, dialog subtitle, and saved-reset footer named the laptop while viewing the server. | Derive location labels from availability in the current view, not the freshest measurement's host. Carry the matched reset reader's machine name with its inventory. UI regressions cover server-only locations, all-machine locations, and inventory supplied by either machine, including fallback after an identity mismatch. |
| 5 | CLI rows repeated fallback provider names, such as `Codex · Codex`; strip descriptions and dialog headings could do the same. | Omit account labels equal to the display name, ignoring case. CLI and UI regressions cover healthy/error/expired/not-installed output, case differences, and preserving meaningful aliases. |
| 6 | Installing a tagged source over an existing install failed with a duplicate plugin ID. An in-place repository-tracking update worked. | README and draft 0.4.1 notes separate new installs from upgrades. Use `plugin source` to distinguish tracking from pinned installs; `plugin update` retains settings for tracking sources. Changing the source requires remove/reinstall with an explicit warning that removal deletes settings, secrets, and schedules. No upgrade was executed while preparing 0.4.1. |
| 7 | A laptop resource temporarily returned `fetch failed` with a null account key, splitting the Max account and changing the pool to `2/3 available · 1 unknown · … · partial`. A later successful read returned the original key. | Retain the last known key for that exact source/resource only when an error omits identity. A collector regression starts with two pooled accounts, runs repeated keyless errors, and verifies unchanged `2/2` availability and pool values, then recovery and a successful switch to a different identity. Separate tests keep never-known keys null and unmerged and prevent old windows crossing an explicit identity change. |

Each code regression (1–5 and 7) was run red before its fix, then green, using only synthetic identities and `example.test` addresses. The fixtures represent the contract; they are not saved account data.

## 0.4.1 automated and browser verification

- `bun install` completed without dependency or lockfile changes; package and npm-lock versions are 0.4.1.
- `bun run check` passed.
- `bun run test` passed: 385 Vitest tests across 17 files and all 3 token-total tests.
- Both commands in CI.md passed independently: zero comment-policy violations across 95 files and all 13 policy regression tests. The full staged-index policy check also passed. The Lefthook pre-commit hook was installed; redacted staged Gitleaks found no leaks.
- `bun run build` used the separate BB 0.44.0 toolchain through `BB_CLI`, preserving SDK 0.5.29 and the existing minimum requirements. All generated `dist/` artifacts were rebuilt for 0.4.1.
- `bun run check:install` passed its isolated production-only source rebuild with Bun, without devDependencies or provider requests.
- `bun run check:release` passed with that BB distribution's npm 11.16.0 selected through `BB_INSTALL_NPM_CLI`: another production-only rebuild, package/lock and artifact versions, SDK/build metadata, host digest, and isolated backend/host smoke loading. No provider requests were made.
- The checksum-verified Woodpecker CLI 3.19.0 accepted `.woodpecker.yaml` with `lint --strict` in a clean environment and temporary HOME, without inherited credentials or API access. No CI configuration was changed; local schema validation is not a claim about hosted platform acceptance.
- The UI detector reported no findings for the changed frontend targets.
- An isolated headless Chromium fixture used the real components and release CSS with synthetic account/RPC data and a host-style preflight. It kept all four displayed accounts (including healthy Codex beside failed OpenCode), the two-account Claude pool, and only the matching login's saved-reset badge. Strip buttons had positive bounds without horizontal overflow at 172, 212, and 252px. Desktop (1200px) and mobile (375px) dialog screenshots and DOM checks confirmed server-only locations, all-machine locations, distinct provider headings, and the actual reset-reader footer; neither dialog overflowed horizontally. The browser session was closed. No development server was started, and this fixture does not reproduce the live BB theme or provider APIs.

## 0.4.1 verification boundary

See [draft release notes](../releases/0.4.1.md) for installation and upgrade guidance.

The installed plugins and settings on both bb servers remain unchanged. No plugin installation, update, reload, reconfiguration, reset redemption, or thread creation/messaging is part of this verification. A live check of 0.4.1 on the other server remains a separate follow-up. The future per-account reset-source RPC remains out of scope.
