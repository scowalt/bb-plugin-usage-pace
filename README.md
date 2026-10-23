# Usage Pace

[![BB](https://img.shields.io/badge/bb-0.44%2B-blue)](https://getbb.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Tells you if the current burn rate lasts until each quota window resets. If the rate does not last, it tells you when the quota runs out and how long you will be without quota.

This fork of [Usage Pace by Charles Lee](https://github.com/chug2k/bb-plugin-usage-pace) adds multiple quota accounts, provider pools, read-only Codex banked resets and Claude limit resets, with account-specific details and an optional server-only view.

Originally a fork of [Usage Bar](https://github.com/dmitriikapustin/bb-plugins-by-kapustin/tree/main/plugins/usage-bar) by Dmitrii Kapustin (MIT). The pace calculation and the usage-card integration are new. The optional footer strip, the dialog, the token totals and the CLI come from Usage Bar. The Grok Build usage comes from [Grok Build Usage](https://github.com/MacHatter1/bb-plugin-grok-build-usage) by MacHatter1 (MIT).

## What it shows

**In bb's usage card** (the built-in Provider usage card in the sidebar footer):

- Each window's bar gets a tick at **even pace**: where the bar would be if you used the quota at an exact even rate.
- The part of the bar between the fill and the tick shows the difference. It is **red** when you are ahead of pace, and light grey (headroom) when you are under pace.
- Hover a row to see the delta under the dates. The row stays open while the pointer is anywhere in the list of rows, so moving between rows does not flicker. On a touch screen (or with the keyboard), tap the row: bb expands it, and the delta shows under bb's reset time:

```
7d    [█████████|██········]  44%   5d 2h
               17% ahead of pace (1d 4h)
        runs out Sun 00:03 · 2d 15h without quota
```

The first line is the difference from even pace, in percentage points and in time. The second line is the time without quota before the reset, or the daily budget that lasts.

The card belongs to another plugin. Usage Pace only adds nodes to it, and reads the card's own data (`bb--provider-usage` `getUsage`, with the visible provider IDs and cached measurements), so the labels always match. If a bb update changes the card's markup, the tick and the delta stop showing, and nothing else breaks.

**Optional compact footer.** Turn on *Also show the Usage Pace strip* in the plugin settings. The pace-first layout is available in v0.3.7 and newer. Each provider account leads with pace, with one compact line per displayed quota window (provider icons represented by letters here):

```
C  W 0.7× pace · 52% used  ↺1
   S 0.5× pace · 32% used
X  W 1.6× pace · 78% used  ↺3
   ▲ 1d 16h short
G  ⌛ resets in 2h 14m
```

- **1.0× is even pace.** Below 1.0× means less quota consumed than even spending over the elapsed part of that window; above 1.0× means faster spending. For example, 11% used after about 21% of a week is `0.5× pace`. This is the account's average since window start, not recent burn or an exact agent-count recommendation. Shared account quotas can span machines, and session/model limits can override weekly headroom.
- `W` and `S`: weekly and five-hour session windows, shown in that order when present. The secondary percentage is quota **used**, not remaining. Missing windows stay absent. Providers with neither show their first window (`M` for monthly, `D` for daily, otherwise its label).
- Pace carries the existing risk colour; used percentages stay secondary and neutral. `near limit` means current use is at least 80%. `high projected use` means the forecast exceeds 85% by reset, without current usage being near a limit—for example, 5% used early in the week with 95% projected. Both retain a visible warning when no exhaustion countdown is shown. Rounding a multiplier to 1.0× does not change the unrounded forecast or risk verdict.
- `▲ 4h short`: at the reported pace, a window is projected to run out **four hours before reset**. The warning uses the earliest projected exhaustion across **all** windows, including hidden model limits. Hover for the window name and time until it runs out. Shortfall and numeric pace stay anchored to the last usage snapshot and are recalculated on refresh; the tooltip's run-out countdown ticks each minute. `out now (est.)` replaces the shortfall when the run-out estimate has passed, without implying confirmed exhaustion.
- `⌛` (amber hourglass): a window is confirmed exhausted. A countdown **replaces pace and quota percentages on the same line**, updating each minute to the **latest reset among exhausted windows**, including model-specific limits (`resets in 2h 14m`, or `resets in <1m`). Hover for individual window percentages and resets. If any exhausted window has a missing or invalid reset time, it shows `reset unknown`. When the countdown reaches zero, the plugin requests fresh usage once, bypassing its cache, and shows `awaiting refresh` until updated data establishes the new state—even if that refresh fails. The countdown describes scheduled quota renewal, not a guarantee of service availability.
- `too early` or `unknown`: a multiplier cannot be judged or the data may be stale/incomplete. Fresh reported percentages remain visible; stale or unobserved quota shows “usage unknown,” without a numeric pace claim, a zero-usage implication, or a stale forecast. A reported exhausted or overshooting window still warns even if another window's pace is unknown. `other pace unknown` keeps uncertainty in an undisplayed window visible beside known selected windows.

Status considers **all** reported windows, including model-specific limits not displayed in the strip. Healthy weekly pace never removes their warnings. Hover for full window names, reset times and run-out estimates; click or keyboard-activate the row for the full dialog. Accessible descriptions explain the multiplier and account-level constraints without relying on colour. Token totals remain in the dialog, not the footer.

### Multiple accounts and pools (0.4.0)

Usage Pace discovers every `provider-usage.v1` source, including machine-local providers, Account Pooler, Claude Accounts, and its own Grok source. Accounts merge only by the provider-issued `accountKey`, never by email, label, or plan. A merged account uses the freshest measurement and lists all reporting sources and machines. Unknown identities stay separate. Failed sources keep their last measurements, marked stale; healthy sources still show pace. Measurements are fetched at most three at a time, with five-second source timeouts.

Each account has a strip row. With two or more accounts, the provider also has a pool row; the dialog places the pool before that provider's accounts. Account labels use **Account aliases** (`email=Alias` pairs, separated by commas or newlines), then the email prefix, then the resource label.

Pool weekly use and pace are plan-weighted: Max 20x weighs 20, Max 5x weighs 5, and Pro weighs 1. **Pool weight overrides** accepts `email=weight` pairs. Unknown plans, stale measurements, and missing weekly windows are excluded from weighted values and mark the result **partial**. Pool pace divides weighted consumption by weighted elapsed budget, rather than averaging the account multipliers. Weekly pool figures say **est.** because session plan multipliers do not establish weekly quota sizes. There is no pool run-out forecast.

Pool availability requires readable shared session/weekly quota; unknown accounts are shown separately. Model-family exhaustion does not block shared availability and is listed separately. A pool is exhausted only when every account is confirmed exhausted; it counts down to the earliest account renewal. Each individual account still counts down to its latest exhausted reset.

```sh
bb plugin config usage-pace set accountAliases 'a@example.test=Work,b@example.test=Personal'
bb plugin config usage-pace set poolWeights 'a@example.test=20,b@example.test=5'
```

**Saved resets (Codex and Claude).** A supported account whose host login identity matches also shows `↺ 3` for three saved resets. Hover for the earliest reported expiration; the badge turns amber when a reset expires within seven days. Click the badge to open and focus that provider account's reset details. `↺ 0` is dimmed, `↺ …` is refreshing a previously verified inventory, and `↺ ?` means a verified inventory read failed or expired since reading—not zero. Unread inventories and mismatched account identities have no badge. Claude matches the profile account UUID; identical email addresses never share a balance. Claude and Codex balances remain separate even when their account emails match.

Codex calls these **banked resets**; its count is provider-reported and details may be incomplete. Claude's **limit resets** are classified by the quota windows they affect: Full, 5-hour, or other saved resets. The Claude badge sums remaining uses in current, unpaused grants, not the number of grant records. A saved grant can count even when it is not currently redeemable. An explicit `no_grant` response with an empty grant list confirms zero saved resets; absent, gated, or malformed inventory remains unknown.

Claude's **conditional 5-hour reset availability** is shown separately in the dialog and never added to the badge. It may be available, unavailable now (for example, the session limit has not been reached), or unknown. Its next-availability time is not an expiry, and reaching that time does not prove the offer is available. Session-only resets still count toward the weekly usage limit.

This is read-only: opening details never redeems a reset. Saved resets do not change quota percentages or pace calculations. The footer and dialog share one inventory, refreshed every five minutes while visible, on focus, or with the dialog's refresh button.

Reads run on the corresponding **BB host**, not necessarily the machine running the server or UI. Codex uses that host's ChatGPT login and a private Codex inventory endpoint. Claude uses that host's Claude Code subscription login with profile scope, verifies account identity through the profile API, and uses the installed CLI version for its private usage API's client headers. Claude credentials are read from `.credentials.json` under `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`, or `~/.claude`; macOS uses the corresponding Claude Code keychain entry. Tokens stay on the host. The plugin does not refresh or rewrite credentials or import browser cookies. If a login expires, refresh Claude Code's login on the signed-in host; a login on the server machine is not required. Private endpoint access can vary; missing or client-gated inventory is unknown, never a guessed zero.

**Dialog.** Click a provider row to open it. Each window shows a bar with a mark at even pace, the rate details, and the result:

```
Weekly limit                    resets in 5d 2h   44%
[██████████████|·······················]
1.6× pace · on track for 161%           2d 15h without quota
· budget 11%/day                   runs out Sun 27 Sep, 00:03
```

`budget` is the rate per day (or per hour, for windows shorter than two days) that lasts exactly until the reset.

## Server-only view

Turn on **Only show providers on the server machine** in Settings → Installed plugins → Usage Pace to limit the compact strip, dialog provider rows, and saved-reset details to the machine running the bb server—not the browser machine or the selected thread's host.

```sh
bb plugin config usage-pace set serverOnly true
```

The setting is off by default, persists across reloads, is shared across browsers, and updates without a reload. Machine-scoped accounts must be available on bb's server-host ID. Shared-scope accounts remain visible because the server serves them. Merged accounts retain the freshest measurement and their availability on every host. If the server is missing or offline, machine-only rows disappear with an actionable error; shared rows remain. Saved-reset reads are limited to the server host and require a matching account identity. The view never substitutes another machine.

This is a display filter: all-host quota collection, bb's separately owned Provider Usage card, `bb usage-pace` output, and **Tokens · across BB** remain unchanged. Saved-reset inventory reads in the strip/dialog follow the displayed accounts. To restore the all-machines view, set `serverOnly` to `false`.

## How pace is calculated

Sources report each window's kind, used percentage, model family, and reset time. The kind supplies the duration for five-hour, daily, and weekly windows. For older sources without a kind, the duration comes from the label: `5h`, `7d`, `Weekly`, `5-hour window`, or `session` (5 hours). A window with no length in its label, for example `Fable`, takes the length of a window that resets at the same time. Then:

- start of window = reset − length
- pace = used ÷ (elapsed ÷ length)
- runs out = now + elapsed × (100 − used) ÷ used, if that is before the reset
- time without quota = reset − runs out

A monthly window ("Monthly credits") starts one calendar month before its reset.

This is a straight-line projection. Nights and weekends usually lower the real rate. In the first 5% of a window, the plugin shows "too early to judge pace" only while less than 5% of the quota has been used. Significant early usage still warns: 11% used five hours into a week is about 3.7× pace. A projection requires positive elapsed time; unknown pace never claims "Lasts to reset".

## Which provider failed

When one provider on a machine fails to refresh, bb's card shows "Couldn't refresh usage. Showing the last available update." on every tab, and does not say which provider failed. Usage Pace moves the message to the tab of the provider that failed:

- That tab gets a red dot, and shows bb's message with the provider's error, for example "opencode: OpenCode Go usage access was denied.".
- The other tabs, whose data is current, show no message.
- When the failed provider is not known, the message shows on every tab, as bb shows it.

The × dismisses the message until a different provider fails or the error changes.

## Hide providers in the card

bb lists some providers on every machine, installed or not. Cursor is one of them. Set *Hide these providers in bb's usage card* to a comma-separated list of names as the card shows them, for example `Cursor`. The provider picker still lists them.

```sh
bb plugin config usage-pace set hiddenCardProviders "Cursor"
```

## Grok Build

bb runs Grok Build through its built-in ACP provider (`acp-grok`), and that provider reports no usage, so bb's usage card has no Grok tab. Usage Pace adds one:

- It registers a companion provider, `usage-pace-grok` ("Grok Build (usage)"), listed only on hosts where the `grok` command is installed. It runs the same Grok Build agent, and it also answers bb's usage request: it reads the Grok CLI login (`~/.grok/auth.json`, made by `grok login`) and asks xAI's billing service (`cli-chat-proxy.grok.com`) for the credit window and its reset.
- It serves bb's `provider-usage.v1` source contract for that provider, so the card shows a Grok Build tab. The tab gets the tick, the band and the hover lines like every other tab.

Because the companion is a full provider, bb's provider picker shows it next to bb's own "Grok Build". Threads on either one run the same agent.

Turn this off with the *Add Grok Build usage to bb's usage card* setting, then reload the plugin. Do not also install Grok Build Usage: both plugins then add a Grok tab.

## Install

```sh
bb plugin install 'git:https://github.com/scowalt/bb-plugin-usage-pace.git@v0.4.0'
# Enable the compact footer rows (off by default), including Codex and Claude resets:
bb plugin config usage-pace set showStrip true
```

Use `@^0.4.0` instead of `@v0.4.0` to track compatible releases with `bb plugin update usage-pace`. **Use 0.3.1 or newer for Git installs**: 0.3.0 fails when development dependencies are absent. Release tags include prebuilt bundles, but BB's Git installer rebuilds source with its own build tooling after installing production dependencies. The required SDK runtime is installed automatically; you do not need to install it manually. Sign into Codex with a ChatGPT account or Claude Code with a Claude subscription on each host where you want that provider's reset information.

From a local checkout:

```sh
bb plugin install ./
```

If you turn on the strip, do not also install Usage Bar. Both plugins put a strip in the same footer. With the Grok setting on (the default), do not also install Grok Build Usage.

## From the terminal

```sh
bb usage-pace              # weekly windows, with pace
bb usage-pace --all        # every window
bb usage-pace --json       # each window has a `pace` object
bb usage-pace --tokens     # token totals across BB
bb usage-pace --resets --json # Codex banked resets on the primary host (unchanged)
```

Text output groups by provider and prints the pool before its accounts. JSON contains `accounts[]` (including `accountKey`, `sources`, `hosts`, `observedAt`, and per-window `pace`) and `pools[]`. `providers[]` is a deprecated alias of `accounts[]` for the 0.4 minor series. Unknown pool values and pace remain null rather than zero. Stale account windows retain the last reported values in JSON with `stale: true`; text and UI show unknown usage. Claude reset details are in the strip/dialog; `--resets` retains its existing Codex-only behavior.

```
Claude Code · Max (5x) (MacBook Pro)
  Weekly limit        44%  resets in 5d 2h
                     runs out Sun 00:03, 2d 15h before reset · 1.6× pace · on track for 161% · budget 11%/day
```

## Requirements

bb **0.44.0+** with bundled Plugin SDK **0.5.29+**. The plugin uses the provider authentication that bb already has. Only providers and hosts that report quota information appear. Token totals are not billing data.

## Development

```sh
bun install
bun run check   # tsc
bun run test    # vitest (pace, reset badge/UI) + node:test (token totals)
bun run build   # bb plugin build
bun run check:install # rebuild an isolated copy with production dependencies only
bun run check:release # includes check:install, metadata/digest and bundle smoke tests
bb plugin reload usage-pace
```

Keep `@get-bb/plugin-sdk` pinned in **dependencies**, not devDependencies: the Grok host bridge imports its runtime during install-time bundling. Do not let SDK type-sync tooling move it back to devDependencies. Browser-shared data must not import the backend SDK; host RPC wiring lives separately in `lib/banked-resets-host-contract.ts`.

`check:install` defaults to Bun. Set `BB_INSTALL_NPM_CLI` to the absolute `npm-cli.js` shipped with the BB version under test for exact dependency-install parity (`--ignore-scripts --omit=dev --omit=optional`). Both modes invoke `bb plugin build` in a disposable checkout and make no provider requests. `check:release` honors the same setting.

Build release artifacts with the toolchain matching the SDK dependency pin: currently BB 0.44.0 / SDK 0.5.29. Set `BB_CLI` to that build toolchain's binary without changing the running BB instance. Newer BB versions can build local development previews, but their SDK metadata does not satisfy this release baseline; never rewrite generated metadata to conceal a mismatch.

Before a release, update the version in `package.json` and `package-lock.json`, run the checks and build (including `check:release` with BB's bundled npm), and commit the generated `dist/` bundles alongside their sources. Every artifact's `pluginVersion` must match the package version. Create a new `vX.Y.Z` tag; never move a published tag.

---

[MIT](LICENSE) · Charles Lee · based on Usage Bar by Dmitrii Kapustin
