See whether your current quota burn rate lasts until reset, directly in bb's
Provider usage card.

## What you get

- **A tick at even pace.** Each bar gets a tick where the bar would be if you
  used the quota at an exact even rate over the window.
- **The difference in colour.** The part of the bar past the tick is red: that
  is how far ahead of pace you are. When you are under pace, the free part up
  to the tick is light grey.
- **The numbers on hover.** Hover a row to see two lines under the dates, for
  example "17% ahead of pace (1d 5h)" and "runs out Sat 23:05 · 2d 16h
  without quota". When the rate lasts, the second line shows the budget that
  lasts to the reset, per day or per hour, or in the last three hours what is
  left.
- **The same on a touch screen.** Tap a row to show the lines. Tap again to
  hide them.
- **Grok Build in the card.** bb's Grok provider reports no usage. Usage
  Pace adds a Grok Build tab with the weekly or monthly credits and their
  pace.
- **Which provider failed.** When one provider fails, bb shows "Couldn't
  refresh usage" on every tab. Usage Pace shows it only on the failed
  provider's tab, with that provider's error, and puts a red dot on that
  tab. You can dismiss the message until the failure changes.
- **Fewer tabs.** bb lists some providers, such as Cursor, on every
  machine. A setting hides the tabs you do not use.
- **Compact footer rows.** One row per account shows weekly/session usage and
  a projected run-out countdown. When exhausted, an amber hourglass and reset
  countdown replace the percentages on one line. It uses the latest exhausted
  reset; missing times show “reset unknown.” Hover for details; click for the
  dialog and token totals. Unknown/stale pace is a dash.
- **Codex and Claude saved resets in the footer.** The optional strip adds a
  `↺ 3` badge with the saved-reset count, earliest-expiry tooltip, and an amber
  warning within seven days of expiry. Click for read-only account details.
  Claude distinguishes full and five-hour saved grants; conditional five-hour
  reset availability is shown separately and never added to the saved count.
  Saved resets do not alter the pace calculation.
- **`bb usage-pace`** prints each window with its pace in a terminal, and
  `--json` gives agents a `pace` object for each window.

## How pace is calculated

Providers report the used percent and the reset time of each window. The
window length comes from its label ("Five-hour limit", "Weekly limit"). A
window without a length in its label takes the length of a window that resets
at the same time. The start of the window is the reset time minus the length.
The plugin then projects the current rate in a straight line to the reset.

Nights and weekends usually lower the real rate, so the projection is a
warning, not a forecast. "Too early to judge pace" applies only while both
elapsed time and quota used are below 5%. Significant early usage still warns;
unknown pace never claims to last until reset.

## Requirements and data

In-card annotations reuse bb's cached Provider usage data with no extra
provider requests. If bb changes the card, annotations may stop showing.
The optional footer reads usage separately and refreshes once when an exhausted
reset countdown ends, awaiting fresh data before implying quota is available.

The saved-reset badges and dialog make separate read-only inventory requests
on the selected BB host, using its local Codex ChatGPT or Claude Code
subscription login. Claude also verifies account identity and uses the installed
CLI version for compatibility with its private usage API. The server/UI host
does not need its own subscription. No tokens leave the provider host, and the
plugin neither rewrites credentials nor imports browser cookies. These private
endpoints may be unavailable; an unknown balance is never shown as zero.
No resets are automatically or interactively redeemed. `bb usage-pace --resets`
remains Codex-only; Claude resets are shown in the strip and dialog.

For Grok Build, it registers a companion provider, "Grok Build (usage)", so
bb's provider picker shows it next to bb's own "Grok Build". It reads the
Grok CLI login from `grok login` and asks xAI's billing service for the
credit window. A setting turns this off.

Usage Pace is a fork of Usage Bar by Dmitrii Kapustin (MIT). The optional
Usage Bar footer strip is still in the plugin, off by default. The Grok Build
usage comes from Grok Build Usage by MacHatter1 (MIT).
