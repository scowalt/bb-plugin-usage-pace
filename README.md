# Usage Pace

[![BB](https://img.shields.io/badge/bb-0.44%2B-blue)](https://getbb.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Tells you if the current burn rate lasts until each quota window resets. If the rate does not last, it tells you when the quota runs out and how long you will be without quota.

This fork of [Usage Pace by Charles Lee](https://github.com/chug2k/bb-plugin-usage-pace) adds read-only Codex banked resets and Claude limit resets, with sidebar badges and account-specific details.

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

The card belongs to another plugin. Usage Pace only adds nodes to it, and reads the card's own data (`provider-usage` `getUsage`, from its cache), so the labels always match. If a bb update changes the card's markup, the tick and the delta stop showing, and nothing else breaks.

**Optional compact footer.** Turn on *Also show the Usage Pace strip* in the plugin settings. It shows one aligned row for each provider account (provider icons represented by letters here):

```
C  ●  W 52%  S 32%  ↺1
X  ▲  W 78%  S 46%  ↺3
      out in 1d 16h
G  ⌛  resets in 2h 14m
```

- `W` and `S`: weekly and five-hour session quota **used**, not remaining. Missing windows stay blank. Providers with neither show their first window (`M` for monthly, `D` for daily, otherwise its label).
- `●`: all reported windows last to reset at the current rate. An amber dot means nearing a quota limit (projected use above 85% or current use at least 80%).
- `▲`: a window is projected to run out before reset. A second line shows time until the earliest projected exhaustion across all windows (`out in 1d 16h`). Hover to see which window. The estimate counts down each minute from the last usage snapshot and is recalculated on refresh; `out now (est.)` means the estimate has passed, not confirmed exhaustion.
- `⌛` (amber hourglass): a window is confirmed exhausted. A countdown **replaces the quota percentages on the same line**, updating each minute to the **latest reset among exhausted windows**, including model-specific limits (`resets in 2h 14m`, or `resets in <1m`). Hover for individual window percentages and resets. If any exhausted window has a missing or invalid reset time, it shows `reset unknown`. When the countdown reaches zero, the plugin requests fresh usage once, bypassing its cache, and shows `awaiting refresh` until updated data establishes the new state—even if that refresh fails. The countdown describes scheduled quota renewal, not a guarantee of service availability.
- `—`: pace is unknown, too early to judge, or the data may be stale/incomplete. Unknown/stale pace has no countdown. A reported exhausted or overshooting window still warns even if another window's pace is unknown.

Numbers stay neutral; only the status glyph carries the pace colour. Status considers **all** reported windows, including model-specific limits not displayed in the row. Hover for full window names, pace multipliers, reset times, and run-out estimates; click for the full dialog. Token totals remain in the dialog, not the footer.

**Saved resets (Codex and Claude).** Each supported row also shows `↺ 3` for three saved resets. Hover for the earliest reported expiration; the badge turns amber when a reset expires within seven days. Click the badge to open and focus that provider account's reset details. `↺ 0` is dimmed, `↺ …` is loading, and `↺ ?` means unavailable or expired-since-read data—not zero. Claude and Codex balances remain separate even when their account emails match.

Codex calls these **banked resets**; its count is provider-reported and details may be incomplete. Claude's **limit resets** are classified by the quota windows they affect: Full, 5-hour, or other saved resets. The Claude badge sums remaining uses in current, unpaused grants, not the number of grant records. A saved grant can count even when it is not currently redeemable.

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

## How pace is calculated

Providers report only `usedPercent` and `resetsAt` for each window. The window length comes from the label: `5h`, `7d`, `Weekly`, `5-hour window`, or `session` (5 hours). A window with no length in its label, for example `Fable`, takes the length of a window that resets at the same time. Then:

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
bb plugin install 'git:https://github.com/scowalt/bb-plugin-usage-pace.git@v0.3.5'
# Enable the compact footer rows (off by default), including Codex and Claude resets:
bb plugin config usage-pace set showStrip true
```

Use `@^0.3.5` instead of `@v0.3.5` to track compatible releases with `bb plugin update usage-pace`. **Use 0.3.1 or newer for Git installs**: 0.3.0 fails when development dependencies are absent. Release tags include prebuilt bundles, but BB's Git installer rebuilds source with its own build tooling after installing production dependencies. The required SDK runtime is installed automatically; you do not need to install it manually. Sign into Codex with a ChatGPT account or Claude Code with a Claude subscription on each host where you want that provider's reset information.

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

Claude reset details are currently in the strip/dialog; `--resets` retains its existing Codex-only behavior.

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

Before a release, update the version in `package.json` and `package-lock.json`, run the checks and build (including `check:release` with BB's bundled npm), and commit the generated `dist/` bundles alongside their sources. Every artifact's `pluginVersion` must match the package version. Create a new `vX.Y.Z` tag; never move a published tag.

---

[MIT](LICENSE) · Charles Lee · based on Usage Bar by Dmitrii Kapustin
