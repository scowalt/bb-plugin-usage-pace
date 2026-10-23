---
name: usage-pace
description: Check provider quota, burn-rate pace, and read-only Codex/Claude saved-reset status.
---

Run `bb usage-pace` for weekly windows grouped by provider, with the pool before its accounts. `--all --force` refreshes every window from all discovered `provider-usage.v1` sources. `--json` returns `accounts[]`, `pools[]`, and a `pace` object on each window (`ratio`, `projectedPercent`, `runsOutAtMs`, `lockoutMs`, `budgetPerHour`). `providers[]` is a deprecated alias of `accounts[]` through 0.4.x. Identify accounts by `accountKey`, not email; null identities stay separate. Unknown/stale pace is null. Pools are plan-weighted weekly estimates, may be partial, and have no run-out forecast. `--tokens` gives recorded token totals. Grok Build is provider `usage-pace-grok`.

The compact strip and dialog show read-only Codex/Claude saved-reset counts and expirations. Claude's conditional five-hour availability is separate from that count; its next-availability time is not an expiry. Missing inventory means unknown, not zero. A badge appears only after the host login's provider-issued identity matches the quota account; a verified failed read shows `↺ ?`, and an unread or mismatched inventory has no badge. Reads use the default login on an available BB host; shared-source accounts need a matching host login for reset details. The server/UI machine does not need a subscription. No resets are redeemed and credentials stay on the host.

`bb usage-pace --resets --json` retains its Codex-only inventory on the primary host; it does not report Claude resets. Claude's inventory is currently available in the strip/dialog.

For a server-only strip/dialog, run `bb plugin config usage-pace set serverOnly true` (off by default, shared across browsers, no reload needed). Machine-scoped accounts must be available on the server, while shared-scope accounts stay visible. Reset reads stay on the server host. This is a UI filter; the Provider Usage card, CLI, and token totals remain global. Configure aliases with `accountAliases` (`email=Alias`) and estimated pool weights with `poolWeights` (`email=weight`), using comma/newline-separated pairs. See [server-only view](../../README.md#server-only-view) for host selection, empty states, and reset-read scope.
