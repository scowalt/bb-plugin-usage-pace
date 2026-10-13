# Compact pace-first verification

Implemented the approved A hierarchy from [the spec](compact-pace-first.md). The implementation commit is separate from the earlier throwaway prototype commits; it does not add the demo, switcher, scenarios or prototype server to production.

## Initial source-only verification

- `npm run check`: passed with the existing SDK dependency pin.
- `npm test`: 302 Vitest tests across 13 files and 3 token-total Node tests passed.
- Targeted strip, compact-row and saved-reset tests: 92 passed.
- Pre-commit comment-policy check: passed, 79 files and zero violations.
- `npm run build`: passed using installed BB 0.46.0. Its bundled SDK is 0.6.37, while this repository intentionally remains pinned to SDK 0.5.29.

The SDK mismatch produced a build warning. At this initial source-only checkpoint, generated outputs from the newer toolchain were not retained: committed `dist/` still contained v0.3.6. No SDK upgrade, release, installation or installed-plugin reload was performed during that checkpoint. The user subsequently requested a live installation, confirmed the result, and authorized release v0.3.7.

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

## Release v0.3.7 verification

The user tried the implementation in their running BB instance, confirmed the result, and requested publication on remote main with a new release.

- Started from remote main and carried only the production implementation and approved specification; the throwaway prototype files and startup command are excluded.
- Updated package and npm-lock versions to 0.3.7 without changing dependencies or compatibility ranges.
- Built all release artifacts with an isolated BB 0.44.0 / SDK 0.5.29 toolchain. All artifact versions and SDK metadata match the manifest, preserving the existing compatibility baseline without altering the running BB server.
- TypeScript checking, all 305 application tests, and all 13 comment-policy regression tests passed. The source checker examined 76 files with zero violations.
- Production-only source installation using that BB toolchain's npm passed with development dependencies unavailable.
- Release metadata, host artifact digest, and isolated backend/host loading with BB's SDK runtime passed. These installation and release smoke tests made no authenticated provider requests.
- Generated release bundles are committed alongside the sources.
