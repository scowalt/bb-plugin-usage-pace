---
name: usage-pace
description: Check provider quota, burn-rate pace, and read-only Codex/Claude saved-reset status.
---

Run `bb usage-pace` for weekly windows with pace, `bb usage-pace --all --force` for every window from all reporting hosts, and `bb usage-pace --json` for a `pace` object on each window (`ratio`, `projectedPercent`, `runsOutAtMs`, `lockoutMs`, `budgetPerHour`). `bb usage-pace --tokens` gives recorded token totals. Grok Build shows up as provider `usage-pace-grok`. Pace is a straight-line projection from the start of the window; it is null for labels with no known length.

The compact strip and dialog show read-only Codex/Claude saved-reset counts and expirations. Claude's conditional five-hour availability is separate from that count; its next-availability time is not an expiry. Missing inventory means unknown, not zero. Reads use the login on the corresponding BB host; the server/UI machine does not need a subscription. No resets are redeemed and credentials stay on the host.

`bb usage-pace --resets --json` retains its Codex-only inventory on the primary host; it does not report Claude resets. Claude's inventory is currently available in the strip/dialog.

For a server-only strip/dialog, run `bb plugin config usage-pace set serverOnly true` (off by default, shared across browsers, no reload needed). This is a UI filter; the Provider Usage card, CLI, and token totals remain global. See [server-only view](../../README.md#server-only-view) for host selection, empty states, and reset-read scope.
