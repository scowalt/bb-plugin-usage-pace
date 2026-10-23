# Usage Pace: multiple Claude accounts

Spec, 2026-10-23, implemented for Usage Pace 0.4.0 in scowalt/bb-plugin-usage-pace.

## Implementation decisions

- The browser route is `/api/v1/plugins/bb--provider-usage/rpc/getUsage`: verified HTTP 200 on local bb 0.46.0; `provider-usage` returned HTTP 404. Requests use `providerIds` derived from the card's tabs and discovered account metadata.
- No host-local collection fallback: discoverable usage contracts predate the supported bb 0.44.0 floor. Empty discovery means no accounts; failed discovery keeps prior measurements, marked stale. Grok remains its own discovered source.
- Weekly pool weights default to reported plan multipliers (Pro with a null multiplier weighs 1), explicitly labelled estimates. No claim is made that weekly quotas scale exactly. Overrides remain available.
- Unknown availability is counted separately. A pool revives at the earliest account renewal, where each account first needs all its exhausted shared windows to renew. Model-family exhaustion is separate.
- Reset inventories carry the provider-issued identity, including Claude's profile UUID and Codex's ChatGPT account ID. Unverified or unread inventories have no badge. The future per-account reset-source RPC is not implemented.
- `providers` remains a deprecated alias through 0.4.x; CLI schema tests require `accounts`, `pools`, and nullable per-window pace.

The original implementation brief follows.

## Problem

Usage Pace shows one Claude account per machine. It builds its snapshot from `bb.sdk.system.usageLimits({ hostId })` (`server.ts:222`), and that call reads only each machine's default Claude Code login. bb's Provider Usage README says: "`bb settings usage --json` and `bb.sdk.system.usageLimits()` remain the host-local provider-maintenance view; they do not aggregate shared pool accounts." Accounts served by Account Pooler, or by the planned Claude Accounts plugin, never reach the strip, the dialog, or the CLI.

## Proposed scope

1. Read quota from every `provider-usage.v1` usage source. bb's own usage card uses the same contract.
2. Show one row per quota account, deduplicated across machines and sources by the account identity the provider issues.
3. Add a pool row per provider when two or more accounts are shown.
4. Make the in-card annotations account-aware, and fix the request the card integration sends today.
5. Show a saved-reset badge only on the account whose inventory was actually read, never on another account.

Out of scope: routing, writing to accounts, redeeming resets, and forecasts built from usage history.

## Verified facts (bb 0.46.1, 2026-10-23)

- **Discovery.** `bb plugin rpc list --method provider-usage.v1.listResources` lists `provider-acp`, `provider-claude-code`, `provider-codex`, and `usage-pace` (its Grok source). When enabled, Account Pooler registers the same contract (`plugins/account-pool/src/usage-source.ts`).
- **SDK.** The pinned SDK 0.5.29 typings already include `bb.sdk.plugins.experimental_discoverRpc` and `bb.sdk.plugins.callRpc` (`bundled-types/bb-plugin-sdk.d.ts:15987,15991`). bb's CHANGELOG records the combined pooled and machine-local view in 0.43.3, below Usage Pace's 0.44.0 floor.
- **Identity.** `listResources` is cheap and can return `accountKey: null` for machine resources. The measurement from `getResource` carries the identity. Observed:
  - `provider-claude-code` resource `["host_enxefywffu","claude-code"]` → `accountKey: anthropic:account:3a7e…`, plan `{ id: "max", multiplier: 20 }`.
  - Its windows are a `five-hour` "Current session" at 36 %, a `weekly` "Weekly limit" at 16 %, and a `weekly` "Fable" window at 1 % with `model: "fable"`.
  - The MacBook resource returns the same `accountKey`.
- **Windows.** Each window has a `kind` (`five-hour`, `daily`, `weekly`, or `custom`), an `id`, a `model` (a model family or null), and a `cost`. `usedPercent` can exceed 100 for overage.
- **Account Pooler resources.** Each is `scope: shared` with the email as label. Its `accountKey` is `anthropic:account:<uuid>` for Claude and `openai:chatgpt:<id>` for Codex.
- **Bug today.**
  - `lib/card-pace.ts:511` posts `{ force, machineIds: null, providerId: null, maxAgeMs }` to Provider Usage's `getUsage`.
  - bb 0.46.1 validates that input strictly and requires `providerIds: string[]`. The same body returns HTTP 400 "rpc input validation failed" through `bb plugin rpc call bb--provider-usage getUsage`.
  - With `providerIds: []`, the card returns no measurements, so pass the IDs you want.
  - The CLI knows the plugin as `bb--provider-usage`. Check which ID the browser route accepts.
- **Pool groups.** In the card's response, a shared source appears as a machine with ID `source:<pluginId>`, and each of its providers carries `accountLabel`.

## Design

### Collection (server)

- On each refresh:
  1. Discover the sources.
  2. Call `listResources` on each source.
  3. Call `getResource({ resourceId, refresh: force })` for each resource, at most three at a time (Provider Usage's limit), each with a 5-second timeout.
- Skip machine-scoped resources on disconnected machines, as the card does. A source that fails keeps its last snapshot, and its rows are marked with the error.
- Keep the `cacheMinutes` cache and the `force` path. Discovery results can be cached for one minute.
- Grok needs no special path, because Usage Pace's own source is discovered like any other. Remove the `system.usageLimits` path once parity tests pass. Keep it only as a fallback for when discovery returns nothing, and only if a supported bb version needs it.

### Accounts

- An account's identity is the `accountKey` from its measurement. Rows with the same non-null key merge into one account, whatever source or machine reported them. A null key never merges, which is Provider Usage's rule. Never merge by email, label, or plan.
- A merged account keeps:
  - the windows from the freshest measurement by `observedAt`;
  - every place it is available (`hosts`, `sources`);
  - the plan and email from the freshest measurement.
- Replace `UsageProvider` with `UsageAccount`, which adds `accountKey`, `sources`, `hosts`, `observedAt`, and each window's `kind` and `model`. Derive `weekly` from `kind === "weekly"`. Fall back to the label pattern for sources that send no `kind`.

### Display

The strip keeps its pace-first layout, with one row per account and a pool row:

```
C A  W 0.7× pace · 52% used  ↺1
     S 0.5× pace · 32% used
C B  W 1.3× pace · 71% used
     ▲ 9h short
C C  ⌛ resets in 2h 14m
C ∑  2/3 available · W 0.9× pace · 58% used (est.)
```

- **Account label.** Use the alias from a new `accountAliases` setting (`email=Alias` pairs). Otherwise use the part of the email before the @. Otherwise use the source's label.
- **Pool row.** Shown when a provider has two or more accounts on display.
- **Dialog.** Group by provider, with a pool section followed by one section per account. Each account section keeps the current per-window layout and adds "Available on: Beelink, MacBook · via Claude Accounts" and "observed 3m ago".
- **Server-only view.** The server serves shared-scope accounts, so they stay visible. Machine-scoped accounts keep the current filter.

### Pool math

These numbers are computed per provider, over the accounts on display whose plan is known.

- **Weight.** `w` is the plan multiplier: Max 20x is 20, Max 5x is 5, and Pro is 1. A `plan.multiplier` of `null` with plan ID `pro` also counts as 1. Accounts whose plan is unknown are left out of the weighted numbers, and the row says "partial". A `poolWeights` setting (`email=weight`) overrides the defaults. Weighted numbers are labelled "est.", because Anthropic publishes the multiplier for session usage, not the size of weekly limits.
- **Pool weekly use.** `Σ wᵢ·usedᵢ / Σ wᵢ`.
- **Pool weekly pace.** `Σ wᵢ·usedᵢ / Σ wᵢ·(100 · elapsedFractionᵢ)`. 1.0× means the pool as a whole is at even pace. The number stays meaningful when the router drains one account after another.
- **Available.** Accounts with no confirmed-exhausted shared window (session or weekly). Exhausted model-family windows are listed separately, for example "Fable 1/3".
- **Pool exhaustion.** The pool is exhausted only when every account is confirmed exhausted. Its countdown runs to the earliest reset among them, because the pool comes back when any one account does. A single account keeps today's rule: the latest reset among its exhausted windows.
- **No pool forecast in v1.** A useful pool run-out estimate needs recent pool-wide burn, and Usage Pace stores no usage history (its `data.db` holds only token totals). Per-account rows keep their own forecasts and warnings.

### In-card annotations

- Fix the request to `{ force: false, machineIds: null, providerIds: <IDs of the tabs shown>, maxAgeMs }`.
- Parse `accountLabel` and the machine ID, including `source:<pluginId>` groups.
- Match a row by machine, provider, and account section. If the card shows several accounts under one provider and the row's account can't be identified, draw nothing. Never use another account's reset time.
- Test against fixtures of the card's current markup, including a shared group with two accounts.

### Saved resets

- The reset reader uses each machine's default login (`lib/claude-limit-resets.ts:104`). Show its badge only on the account whose `accountKey` matches that login. Compare the account UUID from `/api/oauth/profile`, not the email as the code does today.
- An account without a readable inventory shows no badge. `↺ ?` keeps its meaning, a failed read.
- Later: a read-only RPC, `claude-limit-resets.v1.get({ accountKey })`, that any source holding an account's login can implement. Claude Accounts could fill it from the `/api/oauth/usage?at_wall=1&skip_spend=1` response, which returns the grants Usage Pace already parses. For Account Pooler, see get-bb/bb#4157.

### CLI

- `bb usage-pace` groups its text by provider and prints the pool line before the accounts.
- In `--json` output:
  - `providers[]` becomes `accounts[]`, adding `accountKey`, `sources`, `hosts`, and `observedAt`. Each window keeps its `pace` object.
  - A new `pools[]` holds `{ providerId, accounts, available, usedPercent, pace, partial }`.
  - Keep `providers` as a deprecated alias for one minor version, because agents read it.

### Glossary additions

- **Account**: a quota identity issued by a provider (`accountKey`). One account can be signed in on several machines and reported by several sources.
- **Usage source**: a plugin that implements `provider-usage.v1`.
- **Pool**: the accounts Usage Pace shows for one provider.

## Acceptance

- With three Claude accounts served by Claude Accounts or by Account Pooler, the strip shows three Claude account rows and a pool row. Account A appears once, even though it is also each machine's default login.
- The Grok tab and the Codex rows are unchanged.
- The card's ticks draw again, and a regression test covers the request body.
- No account ever shows another account's reset time or saved resets.
- Unknown or stale usage never shows as 0 %.
- A schema test validates `bb usage-pace --json`.

## Test plan

- **Unit tests:**
  - deduplication: the same key from two sources and two machines; null keys; two accounts with the same email;
  - pool math: weights, partial pools, the exhaustion countdown;
  - weekly detection from `kind` and from labels;
  - card matching with two accounts under one provider.
- **Fixtures:** scrubbed real `getResource` outputs from `provider-claude-code`, Account Pooler, and Claude Accounts.
- **Live check:** on bb 0.46.1 with Claude Accounts serving at least two accounts. Run `check:release` on the 0.44.0 toolchain as today.

## Open questions

1. Does the browser RPC route accept `provider-usage` or `bb--provider-usage` as the Provider Usage plugin ID?
2. Should the `system.usageLimits` path stay as a fallback?
3. Do weekly limits scale with the plan multiplier? This decides the default pool weights.

## Unrelated, seen while checking

`bb plugin list` reports one error for Usage Pace: "rpc getBankedResets failed: rpc input validation failed". I did not investigate it.
