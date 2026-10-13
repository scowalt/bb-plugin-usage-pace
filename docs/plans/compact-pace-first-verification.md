# Compact pace-first verification

Implemented the approved A hierarchy from [the spec](compact-pace-first.md) on the current branch. The implementation commit is separate from the earlier throwaway prototype commits; it does not add the demo, switcher, scenarios or prototype server to production.

## Automated checks

- `npm run check`: passed with the existing SDK dependency pin.
- `npm test`: 302 Vitest tests across 13 files and 3 token-total Node tests passed.
- Targeted strip, compact-row and saved-reset tests: 92 passed.
- Pre-commit comment-policy check: passed, 79 files and zero violations.
- `npm run build`: passed using installed BB 0.46.0. Its bundled SDK is 0.6.37, while this repository intentionally remains pinned to SDK 0.5.29.

The SDK mismatch produces a build warning. Generated outputs from that newer toolchain were not retained in this source-only change: committed `dist/` remains the existing v0.3.6 release. Build the checkout before loading the new layout. No SDK upgrade, release, installation or installed-plugin reload was performed.

## Live BB checks

Verification substituted the built frontend and fixture RPC responses in a private headless BB tab. It did not replace the installed plugin or change its settings.

- Exercised known weekly/session pace, projected exhaustion, hidden constraints, near limits, uncertainty, early windows, stale data, confirmed exhaustion, fallback labels and large multipliers.
- Enter opened the actual usage dialog; Enter on the separate saved-reset badge opened and focused the matching inventory section.
- The native collapsed-sidebar state hid the strip; restoring it restored the strip.
- Final desktop checks used actual content widths of 172, 212 and 252px, allowing for the navigation rail and footer padding at nominal sidebar widths of 240, 280 and 320px. Normal weekly/session readouts stayed on one line with no overflow.
- At a 390×844 viewport, the same three actual content widths retained single-line normal readouts without overflow. The footer briefly unmounts during BB's responsive transition, so checks wait for its host to return.
- Extremely large multipliers and long fallback labels may wrap rather than clip. Used quota and pace remain visible.
- No page errors were reported in the successful inspection batches.

The narrow-width layout uses the account row as a container: under 200px it tightens horizontal spacing and hides only the optional separator, retaining the pace word, percentage, used label, identity and saved-reset control.

## Review disposition

**Standards:** The independent review flagged generated SDK metadata drift. Resolved by retaining the published v0.3.6 bundles rather than committing newer-toolchain artifacts or changing dependency pins. No baseline code-smell findings were reported.

**Spec:** The independent review found that a hidden 96%-used window with a missing or invalid reset only showed uncertainty, suppressing its near-limit warning. Fixed by reusing the existing current-use tone thresholds independently of pace availability; both reset cases now have rendered-strip regression tests. The metadata finding was resolved as above.
