## Problem Statement

The compact Usage Pace strip tells me how much quota I have consumed and whether it is likely to last until reset, but not how far below or above even pace I am. Seeing an icon, a green dot, `W`, and `11%` does not answer whether I should run more agents or ease off.

For the snapshot discussed during prototyping, approximately 21% of the weekly quota window had elapsed while only 11% of its quota had been used: about 0.53× even pace. That useful comparison is currently hidden in a tooltip and the usage dialog. A green dot only communicates that the reported quota windows last to reset; it does not communicate the magnitude of unused budget relative to pace.

I need the pace comparison visible during normal work, without opening another surface, while retaining the information and safeguards that stop a low weekly pace from concealing a session or model-specific limit.

## Solution

Implement the user-selected **A — pace-first** compact-strip design. On an ordinary weekly row, the provider icon and `W` are followed by a prominent `0.5× pace`, a secondary `11% used`, and the existing saved reset balance badge. Replace the ordinary yes/no status dot with the visible multiplier rather than adding another competing primary metric.

Use one compact line per displayed quota window. When both weekly and session windows exist, show them separately so their multipliers cannot be mistaken for each other. Retain the provider/account grouping and a single saved reset balance badge for the account. Most healthy rows need no additional explanatory text.

The reference is 1.0× even pace. Below 1.0× means the account has consumed less quota than even spending over the elapsed portion of that window; above 1.0× means it is consuming faster. This is an average from the beginning of the quota window, not instantaneous burn or an exact agent-count recommendation.

Preserve visible projected-exhaustion warnings, confirmed-exhaustion reset countdowns, uncertainty, and all-window status precedence. The selected visual hierarchy must not turn an unhealthy account into a reassuring weekly-only readout. Clicking or keyboard-activating a row still opens the existing usage details; clicking the separate saved reset balance badge still focuses that account's reset details.

## User Stories

1. As a person running coding agents, I want to see my quota pace directly in the compact strip, so that I can decide whether to increase or reduce activity without opening a dialog.
2. As a person with unused quota, I want a below-even multiplier such as 0.5× to be the primary number, so that I can see the magnitude of my headroom rather than only a healthy dot.
3. As a person consuming quota quickly, I want an above-even multiplier such as 1.6× to be visible, so that I can recognise overspending before confirmed exhaustion.
4. As a person spending evenly, I want to understand that 1.0× is the reference, so that I can interpret the number consistently across providers and windows.
5. As a person scanning the strip, I want the reported used percentage to remain visible as secondary information, so that I can distinguish pace from quota already consumed.
6. As a person with a weekly quota window, I want its multiplier explicitly associated with the weekly label, so that I do not confuse it with a session quota.
7. As a person with a session quota window, I want its own labelled pace line, so that I can see short-term constraints independently of weekly headroom.
8. As a person with weekly and session windows, I want a fast-burning session to remain conspicuous when weekly pace is low, so that I do not increase work based on the wrong allowance.
9. As a person affected by model-specific quota windows, I want those limits to continue influencing visible warnings, so that an undisplayed window cannot quietly block work.
10. As a person with a daily or monthly quota window, I want the existing fallback label and its valid pace displayed, so that pace-first is not restricted to weekly subscriptions.
11. As a person with an unrecognised quota window duration, I want pace described as unknown rather than guessed, so that I do not act on fabricated information.
12. As a person whose provider does not report a reset time, I want to retain the known used percentage without a numeric pace claim, so that missing data is not treated as healthy usage.
13. As a person just starting a quota window, I want a concise too-early state when the existing estimator cannot judge pace, so that the interface does not imply false precision.
14. As a person making significant use early in a window, I want a valid high pace and its warning to remain visible, so that the early-window safeguard does not hide meaningful overspending.
15. As a person viewing a failed or incomplete refresh, I want stale pace clearly marked unknown, so that a previously reassuring multiplier is not presented as current evidence.
16. As a person viewing a quota window whose scheduled reset has passed, I want the stale multiplier withdrawn until refreshed usage establishes the new state, so that old-window data cannot reassure me about a new allowance.
17. As a person viewing more than one window, I want known pace and uncertainty distinguished without an all-windows-healthy claim, so that partial information stays useful without becoming misleading.
18. As a person approaching a quota limit, I want the existing warning treatment preserved even when pace is sustainable, so that a low multiplier does not conceal very little remaining quota.
19. As a person facing projected exhaustion, I want the existing time-to-run-out estimate visible with the pace readout, so that I can judge urgency as well as rate.
20. As a person facing multiple projected exhaustions, I want the earliest estimate across all reported quota windows retained, so that the most immediate constraint determines the warning.
21. As a person whose run-out forecast time has passed, I want it identified as an estimate rather than confirmed exhaustion, so that I can distinguish prediction from the provider's report.
22. As a person with confirmed exhaustion, I want the reset countdown to replace ordinary pace and usage values, so that recovery timing takes precedence over a historical multiplier.
23. As a person with more than one exhausted quota window, I want the reset countdown to use the latest scheduled reset among those windows, so that an earlier renewal does not promise full recovery.
24. As a person with an exhausted window lacking a valid reset, I want to see reset unknown, so that the strip does not invent a renewal time.
25. As a person whose exhausted reset countdown reaches zero, I want the existing refresh-once and awaiting-refresh behaviour retained, so that a countdown reaching zero is not mistaken for confirmed availability.
26. As a person using multiple providers or accounts, I want provider identity and account grouping preserved, so that I attach the multiplier to the right quota.
27. As a person using the same account on several machines, I want existing deduplication and account-quota semantics preserved, so that I do not treat a shared allowance as independent machine-local budgets.
28. As a person using the server-only view, I want the new readout to respect that filter before deduplication, so that another machine's row cannot replace the server's entry.
29. As a person whose server is offline or has no reporting providers, I want the current actionable empty state instead of a remote fallback, so that the strip remains honest about its scope.
30. As a person holding saved resets, I want the existing separate balance badge and expiration treatment retained, so that quota pace does not hide my read-only inventory.
31. As a person whose saved reset inventory is unknown or loading, I want those states preserved rather than shown as zero, so that missing inventory is not mistaken for an empty balance.
32. As a person opening usage details, I want the same provider/account details and full window names available, so that the compact readout remains a summary rather than a replacement for detailed information.
33. As a person using a keyboard or screen reader, I want window identity, used quota, pace meaning, uncertainty and warnings included in the accessible row description, so that the hierarchy is understandable without colour or hover.
34. As a person using a narrow sidebar, I want the multiplier, secondary usage and saved reset balance to fit at existing density, so that the feature does not require widening the application or conceal important values.
35. As a person collapsing the sidebar or disabling the optional strip, I want the existing visibility behaviour preserved, so that the feature does not introduce unwanted chrome or extra data collection.
36. As a person observing the strip between usage refreshes, I want pace anchored to the reported snapshot while existing countdowns continue ticking, so that time passing alone does not make unchanged usage appear to be a new burn-rate measurement.
37. As a person reading this indicator, I want the average-rate limitation explained in the existing details or documentation, so that I do not interpret 0.5× as permission to launch exactly twice as many agents.

## Implementation Decisions

- **Chosen direction:** A — pace-first. The user explicitly selected it after comparing three prototypes. Adopt its information hierarchy, not the throwaway implementation or synthetic fixture handling.
- **Affected modules:** the compact usage-row projection and the rendered usage-strip module. Use the existing pace-calculation, formatting, usage-display-scope, refresh and saved-reset modules rather than adding another estimator, data store or display surface.
- **Read-model interface:** expose the selected window's structured pace result and explicit display availability through the existing compact row/window interface. The renderer must not parse a tooltip string to recover a multiplier, infer a duration itself, or calculate pace independently. Keep the extension small and local to the compact-strip consumer.
- **Calculation:** reuse the existing straight-line ratio: used quota divided by the percentage of the quota window elapsed. Preserve duration recognition, calendar-month handling, sibling-window duration inference, clamping and the early-window guard. No estimator or threshold changes are part of this feature.
- **Snapshot semantics:** derive visible ratios from the same report timestamp currently used for compact-row forecasts, capped at the current time. Do not recalculate a different ratio from the minute clock while the reported usage is unchanged. Countdown labels continue to use current time.
- **Formatting:** reuse the established multiplier formatter, including its × symbol, one decimal below 10× and integer formatting for larger multipliers. Keep 0.0× a known value when supported by valid elapsed time and reported zero use; reserve unknown for unavailable or unreliable pace. A rounded 1.0× does not override the unrounded forecast or existing warning thresholds.
- **Layout:** render weekly before session, one compact line per displayed window. Keep provider identity on the account's first line, repeat the window label on each line, and retain a single separate saved reset balance badge. Use the existing daily/monthly/first-window fallback when neither weekly nor session is available. Missing windows remain absent rather than receiving fabricated values.
- **Hierarchy:** the multiplier and the word pace lead; used quota remains neutral and secondary. Remove the ordinary healthy/near-limit dot as a competing normal-state primary indicator. Exceptional warning, uncertainty and confirmed-exhaustion indicators remain permissible where necessary for safety.
- **Colour and meaning:** retain existing semantic colours and risk thresholds; do not introduce a new quota or pace tolerance. Colour may reinforce state but must never be its only expression. Below pace is not a failure state. A sustainable but near-limit window must retain its warning treatment.
- **All-window safety:** keep provider-level status based on every reported quota window, including undisplayed model-specific windows. A low selected multiplier must not remove an account-level risk signal. Retain the visible projected-exhaustion countdown and use a concise visible qualifier for an undisplayed near-limit or unknown window when the selected readouts alone would otherwise conceal that state. Full window identity and explanation remain available in accessible descriptions and details.
- **Uncertainty:** show short too-early or unknown text in place of an unavailable multiplier, while retaining trustworthy used percentages. Failed transport/collection, incomplete snapshots and elapsed resets must not produce reassuring current pace claims. Preserve the established status precedence, including awaiting refresh after exhausted scheduled resets pass.
- **Projected exhaustion:** retain the earliest forecast across all windows, the minute countdown, the estimated-now wording, and the withdrawal of forecasts when the snapshot is no longer reliable. A forecast crossing its run-out time does not become confirmed exhaustion.
- **Confirmed exhaustion:** preserve the current overriding hourglass/reset-countdown presentation instead of trying to fit a historical multiplier beside it. Preserve latest-exhausted-reset selection, reset unknown, less-than-a-minute formatting, request coalescing and the refresh-once/awaiting-refresh lifecycle.
- **Interactions and accessibility:** keep the existing dialog-opening interaction for the quota row and the separate provider/account-focused saved reset balance interaction. Include full window names, used percentages, multiplier meaning, uncertainty and aggregate warnings in accessible descriptions. Preserve focus visibility and keyboard activation.
- **Scope and data contracts:** no server/host RPC, provider authentication, collection schema, configuration, persistence or inventory changes. Respect the existing optional-strip and server-only settings, filtering before deduplication, and provider/account-specific saved reset inventory. Pace does not change saved reset balances or reset availability.
- **Production integration:** rewrite the chosen design in the existing production modules using their normal patterns. Keep the prototype variants, switcher, static server, fixtures and simulated sidebar on the throwaway branch. Update the compact-strip usage documentation to explain the multiplier and its reference without implying an exact agent-count recommendation.

## Testing Decisions

- **Primary seam:** the existing rendered usage-strip interface, supplied with controlled usage state, provider/account fixtures and a deterministic clock. This is the highest existing seam that exercises the user-visible hierarchy, row projection, interactions and countdown lifecycle together. No new exported testing seam is required.
- **Seam status:** this existing seam is the proposed testing default stated during synthesis, not a separate architecture decision explicitly approved by the user. The user's explicit selection concerns A's visual hierarchy.
- **Good tests:** assert observable text and accessible meaning, callback targets, status precedence, visibility, clock-driven changes and meaningful refresh side effects. Do not lock tests to CSS grid classes, child counts, internal hooks, private helper calls or whole-DOM snapshots. Adjust existing assertions that encode the old dot-and-columns structure rather than preserving that discarded layout.
- **Modules under test:** chiefly the rendered strip through its public interface. Extend existing compact usage-row interface tests only where structured pace availability and snapshot semantics deserve direct coverage. Reuse the existing pace module's calculation tests; do not duplicate its entire arithmetic suite through the UI or invent a second estimator test surface.
- **Prior art:** existing React/jsdom/Vitest strip tests render with a controlled usage store and fake time, activate the row, exercise reset and run-out countdowns, assert refresh behaviour, and cover server-only scope. Existing compact-row tests cover selected windows, hidden model limits, snapshot-based forecasts, stale/partial data and account deduplication. Existing saved-reset integration tests cover badge targets and inventory states.
- **Acceptance fixture:** use 11% used with approximately 20.765% of a seven-day window elapsed. Assert a visible 0.5× pace associated with W, a secondary 11% used, and preserved saved reset balance. The user must not need hover or a dialog to discover the multiplier.
- **Rate cases:** cover known zero use, below-even, even and above-even pace; rounding near 1.0× must not change the actual risk verdict. Cover large formatted multipliers without clipping. Confirm that significant early usage still warns while genuinely insufficient early information is too early.
- **Window cases:** cover weekly-only, session-only, both in weekly-first order, daily/monthly fallback, unknown duration and duration inference from a sibling window. Verify that absent windows remain absent and values stay attached to the correct labels.
- **All-window cases:** cover low weekly pace with an overspending session; low selected-window pace with a hidden model-window forecast; a hidden near-limit window; and known selected pace with another unknown window. Assert visible and accessible constraints rather than a blanket healthy interpretation.
- **Reliability and time cases:** cover failed refresh, partial snapshot, missing/invalid reset and passed reset. Advancing the clock without a new snapshot must leave numeric pace unchanged while countdowns decrement or change state. A newly reported snapshot may change pace.
- **Exhaustion regressions:** preserve the distinction between projected and confirmed exhaustion, earliest projected run-out, latest exhausted scheduled reset, missing reset, estimated-now wording, countdown completion, one forced refresh and awaiting refresh even after failure.
- **Scope and interaction regressions:** cover account deduplication, separate providers/accounts, server-only filtering before deduplication, no remote fallback, loading/unavailable/no-limits states, dialog activation, and separate saved-reset badge targets. Use existing inventory fixtures; no authenticated provider calls or reset redemption in tests.
- **Visual verification:** inspect the rewritten production strip at 240, 280 and 320 CSS-pixel sidebar widths, with weekly/session rows, long fallback labels, large ratios, early/unknown states, saved reset balances and exceptional countdowns. Include keyboard focus, narrow viewport behaviour and collapsed/disabled strip behaviour. Verify that important values neither overlap nor disappear and that colour is not the sole warning signal.
- **Verification surface:** normal repository type checking, the existing automated test suite, comment-free-source checks and plugin build must pass for implementation. Perform the bounded visual checks in the actual BB sidebar, not only in the simulated prototype. Release/install checks are required if the implementation is packaged for release.

## Out of Scope

- Implementing variants B or C, adding a variant picker to production, or redesigning the wider BB application.
- Adding an exact ahead/behind percentage-point headline, comparison bar or room-to-run-more directive to the ordinary strip. Those were alternative concepts, not the selected design.
- Automatically launching agents, recommending an exact number of agents, changing concurrency limits, throttling work or redeeming limit resets.
- Changing the pace estimator, window definitions, early-window guard, risk thresholds, provider usage collection, authentication, reset availability or saved reset balances.
- Creating instantaneous/recent burn-rate measurement, maintaining historical samples, scheduling around nights/weekends, or treating account quota as machine-local usage.
- Redesigning the full usage dialog, token totals, CLI or separately owned Provider Usage card. Existing details remain available to explain the compact indicator.
- Changing the optional-strip/server-only defaults, introducing per-browser preferences, adding persistence or showing fabricated data for missing windows.
- Publishing a package, reloading the installed plugin, changing repository settings or selecting a new issue tracker as part of writing this spec.

## Further Notes

- The user selected A with “I love A.” This validates the pace-first hierarchy; production correctness and edge-case behaviour still require the normal implementation and verification described above.
- The primary-source prototype is captured locally on branch `prototype/usage-pace-options-thr_vt4cxrycau`, initially committed as `d5d5694`. The branch has not been pushed. The originating BB thread is `thr_vt4cxrycau`, “Show quota usage pace and agent capacity,” based on production commit `5fce1f2`.
- The frozen default snapshot is dated 2026-10-13T00:00:02.171Z. The saved reset count of 2 and alternative scenarios are fixtures, not new provider inventory reads. They must not become production defaults.
- No applicable ADR or configured issue-tracker guidance was found in the repository. Existing domain vocabulary and quota, forecast, reset and account-scope contracts are the authority for this spec.
- **Tracker history:** the origin repository `scowalt/bb-plugin-usage-pace` had GitHub Issues disabled and no `ready-for-agent` label when this spec was drafted, so it was not published as an issue. The user subsequently requested direct implementation, tried the pace-first strip in their running BB instance, and authorized publication on remote main with a new release. This document records the approved specification; no issue tracker, repository setting or triage vocabulary was changed.
