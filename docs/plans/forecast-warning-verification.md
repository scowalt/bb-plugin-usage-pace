# Forecast warning clarity — v0.3.9

## Cause and changes

The compact strip used the combined current-use/projected-use risk tone to describe a quota as `near limit`. A deterministic early-week fixture reproduced `1.0× pace · 5% used · near limit`, although its unrounded pace was 0.951× and its 95% forecast described end-of-window usage, not current consumption.

- Reserve `near limit` for reported current use of at least 80%. Forecast-only warnings say `high projected use`; their tooltip and accessible description distinguish projected use from current quota.
- Replace the ordinary projected-exhaustion countdown with the forecast's gap before reset: `4h short`, rather than `out in 6d 7h`. Reuse the existing pace result's lockout duration and keep the earliest projected exhaustion across all windows, including hidden model limits.
- Keep shortfall and pace anchored to the usage snapshot. Run-out details still count down each minute; refreshed usage can change the shortfall. A passed forecast still says `out now (est.)`, not confirmed exhaustion.
- Preserve risk thresholds, estimator arithmetic, uncertainty, stale-data handling, confirmed-exhaustion reset countdowns, saved-reset inventory and configuration.

## Regression and live evidence

The rendered-strip regression exercises the early-week report both alone and beside the dialog and saved-reset balance. A separate report that runs out in 6d 7h now displays `4h short`, while its tooltip retains the run-out countdown.

Tests also cover shortfall formatting below one minute and at minute, hour and day boundaries; current-use and forecast-warning thresholds; hidden-window precedence; snapshot anchoring; refresh changes; stale reports; and estimated versus confirmed exhaustion.

The user tried and approved a persistent local development installation. The actual BB desktop sidebar, using real provider data, showed `1.1× pace · 7% used · 21h 25m short` with two saved resets and no page errors. No fixture or frontend substitution was used for that installation check. The local build used the running BB 0.46.0 toolchain; release artifacts use the older compatibility baseline below.

## Release verification

- Updated package and npm-lock versions to 0.3.9 and the README installation examples; dependencies and compatibility requirements are unchanged.
- All 323 application tests, TypeScript checking, the comment-free source check and its 13 regression tests passed.
- Built all release artifacts with BB 0.44.0 / SDK 0.5.29. Package, lockfile and artifact versions agree, and generated bundles are included with the release sources.
- Production-only source building with BB's bundled npm, artifact identity/version checks, host digest verification and isolated backend/host loading passed without provider requests.
- The package dry-run audit found 69 files and no prototype variants, picker or development server.
