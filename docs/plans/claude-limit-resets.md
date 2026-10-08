# Claude limit-reset tracking

## Confirmed scope

Track the optional Claude **Full reset** and **5-hour reset** offers shown in Settings > Usage, alongside the existing Codex banked-reset display. These are not scheduled quota renewals or a history of past resets.

- Read-only inventory: never redeem a reset from Usage Pace.
- Add a compact Claude `↺` badge and expiry warnings, matching the Codex presentation.
- Distinguish full and five-hour resets in the details, with their reported expirations.
- Keep optional resets separate from quota percentages and pace calculations.
- Missing, expired-since-read, or unavailable data must not be represented as a confirmed zero balance.

The domain term **limit reset** is recorded in [GLOSSARY.md](../../GLOSSARY.md). No ADR is needed for this reversible extension.

## Verified data source

[Anthropic's limit-reset documentation](https://support.claude.com/en/articles/17007452-what-is-a-limit-reset) describes optional resets, provider-defined scopes, and offer expiration. The user's screenshot shows an available Full reset expiring Oct 22 and no current 5-hour reset.

On 2026-10-07, read-only probes through Tailscale SSH to an authorized subscribed Linux host verified access using that machine's existing Claude Code subscription login. Its installed Claude Code version is 2.1.291. Credentials remained on that machine; no authentication files were changed and no resets were redeemed.

The development machine has no active Claude subscription login. Its stale credential file and HTTP 401 were not evidence of a problem with the user's subscribed host; asking for a new local login was unnecessary.

### Requests and client identity

The installed first-party Claude Code binary supplies the primary protocol evidence. Version 2.1.292 contains both read paths, their response parsers, and the `claude-cli/<version> (external, cli)` user-agent format. The following requests were then verified against the live first-party API on the subscribed host:

```text
GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1
GET https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1
```

Headers used successfully:

```text
Authorization: Bearer <host-local Claude Code access token>
anthropic-beta: oauth-2025-04-20
Accept: application/json
User-Agent: claude-cli/2.1.291 (external, cli) bb-usage-pace
```

The access token had `user:profile` scope. The user-agent suffix identifies Usage Pace while retaining the installed CLI's compatibility identity.

| Read | Observed result |
| --- | --- |
| `cedar_ember=1`, plain `bb-usage-pace` user agent | HTTP 200, but `eligible: false`, `ineligible_reason: "surface"`, empty grants |
| Same request, CLI-compatible user agent above | HTTP 200, eligible, one saved reset |
| `at_wall=1`, same CLI-compatible user agent | HTTP 200, the same saved grant plus explicit session-reset availability |

An empty array accompanying `ineligible_reason: "surface"` must not become a zero balance. These are internal interfaces, not a documented public reset-inventory API; authentication success does not guarantee complete inventory access.

### Saved grant: Full reset

Both successful usage reads returned one grant in `cedar_ember.grants` with these fields (identity fields omitted):

```json
{
  "label": "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
  "resets_total": 1,
  "resets_left": 1,
  "starts_at": "2026-09-22T16:00:00+00:00",
  "ends_at": "2026-10-22T16:00:00+00:00",
  "clears": ["five_hour", "seven_day", "seven_day_overage_included"],
  "paused": false,
  "usable_now": true,
  "use_requires_limit": false,
  "blocking": []
}
```

This verifies one unused reset expiring **2026-10-22 at 16:00 UTC**, matching the date in the screenshot. Its scope covers session and weekly limits; classify by `clears`, not by searching the promotional label. Do not imply that it clears every possible model-specific window.

A grant can contain multiple uses: `resets_left` is the balance, not the number of grant records. `usable_now` and `use_requires_limit` describe redemption conditions, separate from that balance.

### Conditional five-hour/session reset

The `cedar_ember=1` read returned `juniper_tide: null`. The CLI's `at_wall=1` read returned this separate status block:

```json
{
  "eligible": false,
  "ineligible_reason": "not_at_wall",
  "in_experiment": false,
  "arm": null,
  "available": false,
  "next_available_at": null,
  "weekly_resets_at": null,
  "resets_per_week": 1
}
```

The first-party CLI uses this block for a session-only reset, with messaging that the weekly usage limit still applies. For this account, the observed result means **not available now**, with reason `not_at_wall`. It does not establish that a reset will become available on exhaustion; other eligibility checks may then apply.

`resets_per_week` is a policy limit, not a saved or remaining balance. `next_available_at` is an availability time, not an offer expiry. A null block from the other read is not equivalent to confirmed absence. No positive session-reset offer was observed, and the web UI's exact mapping to this block has not been inspected directly.

### Account identity and host routing

A read-only `GET https://api.anthropic.com/api/oauth/profile` also succeeded with the same login and headers. It supplies `account.email`, `account.uuid`, and `organization.uuid`; only field names/presence were printed during investigation. These permit the adapter to verify that reset data belongs to the displayed provider account rather than trusting potentially stale local profile metadata.

Production reads should run through Usage Pace's existing BB host-RPC architecture, on the host signed into Claude. Tailscale SSH was only an investigation tool: do not hard-code the test machine or make SSH a runtime dependency. Browser cookies were not required for any successful probe.

## Confirmed presentation

The user confirmed that `↺` retains the saved-reset count. Details classify saved grants by their reported scope and show the conditional five-hour offer as a separate availability status. Neither `resets_per_week` nor an eligibility boolean is added to the saved-reset count.

## Implementation verification

- Preserve provider/account isolation, including Claude and Codex accounts using the same email on one host.
- Exercise authentication failures, surface-gated or absent blocks, unfamiliar/partial responses, multi-use grants, paused/future/expired grants, and account changes in tests.
- Distinguish a saved balance from redeemability, and an availability time from expiration.
- Cover positive session availability with clearly labeled synthetic fixtures until a real offer is reported; do not manufacture exhaustion or redeem a reset for testing.
- Reuse existing refresh and expiry-warning behavior where the verified provider semantics permit it; preserve Codex behavior.

## Implementation

The Claude adapter is in `lib/claude-limit-resets.ts`. It uses the verified at-wall GET to retrieve both blocks, plus a profile read cached for the current access token. Credentials, executable version probing, and HTTP requests stay on the selected BB host. Provider-aware routing and cache/focus keys keep Claude and Codex separate. The existing Codex-only `--resets` CLI contract is preserved. The legacy `availableCount` wire field represents saved balance, not immediate redemption eligibility.

The actual adapter was bundled and executed over SSH on the authorized subscribed Linux host on 2026-10-08. It returned `status: ok`, one full reset expiring `2026-10-22T16:00:00.000Z`, and conditional session availability `unavailable / not_at_wall`. An allowlisting wrapper confirmed that it made only GETs to the usage and profile paths. No code or credentials were persisted on the remote host.

Unit and DOM tests cover the protocol, bounds, malformed/missing blocks, multi-use grants, scope classification, expiry and future-start boundaries, authentication, cancellation, stale responses, host/provider isolation, and independent session availability. Positive session offers are synthetic fixtures, not claimed live observations. macOS keychain reading follows the first-party service naming convention but has not been live-tested on macOS. Keychain refusals do not fall back to stale credential files. This change is packaged for v0.3.5; installing or reloading deployed copies is separate.

Verification passed: `bun run check`, all 251 Vitest tests plus 3 token-total tests, `bun run build`, and `check:release` with BB's bundled npm (`--omit=dev --omit=optional`). The latter rebuilt an isolated production-only checkout and smoke-tested both readers without provider requests. Generated bundles were rebuilt; no installed plugin was replaced. The comment-free source check and its 13 regression tests also passed for the v0.3.5 release preparation.

## Supporting references

- [Anthropic: What is a limit reset?](https://support.claude.com/en/articles/17007452-what-is-a-limit-reset) — product semantics.
- Installed first-party Claude Code 2.1.292 binary, `~/.local/share/claude/versions/2.1.292` — usage read paths, grant/session-status schemas, request user agent, separate redemption path (not called).
- Live first-party GET responses on the authorized subscribed Linux host, 2026-10-07 — results summarized above; no credential values or account identifiers retained here.
- [Pane provider notes](https://github.com/ItsJazii/pane/blob/main/docs/providers.md) — corroborates the reset-inventory user-agent requirement; independently verified by the live probes.
- [CodexBar Claude notes](https://github.com/steipete/CodexBar/blob/main/docs/claude.md) — corroborates separate grant balance/redemption semantics. Its implementation policies are not automatically Usage Pace requirements.
