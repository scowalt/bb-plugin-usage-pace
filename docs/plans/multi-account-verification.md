# Multi-account verification — 0.4.0

## Automated checks

- TypeScript check passed.
- 363 Vitest tests and all 3 token-total tests passed.
- Comment policy passed with zero violations; all 13 policy regression tests passed.
- BB 0.44.0 / SDK 0.5.29 built all committed artifacts. `check:release` passed with the npm 11.16.0 version declared by that BB distribution: isolated production-only source rebuild, version/SDK metadata, host digest, and backend/host loading.
- CLI schema tests require `accounts`, `pools`, the deprecated identical `providers` alias, account identities/locations/timestamps, and each window's nullable pace.

Regressions cover issued-identity merging across sources and hosts, non-merging null keys and identical emails, freshest measurements, explicit/legacy window kinds, source failures and five-second timeouts, three-request concurrency, discovery caching, login changes, weighted pool math including newly started windows, partial pools, overage, model-family restrictions, and account/pool reset countdowns.

A stale-zero regression prevents old zero-percent measurements appearing as currently available quota in either strip or dialog. CLI text also suppresses stale percentages; JSON preserves historical values marked stale.

Card tests use current account-section markup with two accounts and different weekly resets. The request regression requires plural, nonempty `providerIds`. Unknown account sections and unmatched machines draw no annotation. Saved-reset tests match Claude profile UUIDs and Codex account IDs, including two accounts with identical emails, and hide unread/unverified inventories.

## Read-only live checks

Using the running BB instance and CLI 0.46.0, the actual collector read its discovered provider sources without installing or reloading the changed plugin. It merged one Codex identity reported by three hosts into one account, preserved a readable Claude account with three windows, kept unknown/expired identities separate, and isolated an existing OpenCode subscription-read error. No reset inventory was requested or redeemed.

The canonical browser RPC route `/api/v1/plugins/bb--provider-usage/rpc/getUsage` returned HTTP 200 with the plural provider-ID request; the unprefixed `provider-usage` route returned HTTP 404.

## Browser fixtures

A temporary, isolated browser fixture rendered the actual components and compiled CSS with synthetic accounts and a host-style preflight. It showed three Claude rows, one pool, and only the matching account's saved-reset badge. At container widths 172, 212, and 252px, every button had positive dimensions and none overflowed horizontally. Opening details showed the pool before accounts, source/host availability, observation age, per-window pace, and read-only resets. The responsive dialog at 375px fit the viewport without horizontal overflow and retained all three accounts. Browser sessions were closed; no development server was started.

This checks component layout and matching, not installation into the user's current BB theme or a live shared-source card.

## Before publication

A live check on bb 0.46.1 with Claude Accounts serving at least two accounts remains outstanding: neither Claude Accounts nor Account Pooler was installed here. Shared-source quota fixtures are representative contract fixtures, not fabricated live captures. The future per-account reset-source RPC remains out of scope. The installed plugin and its settings were left unchanged.
