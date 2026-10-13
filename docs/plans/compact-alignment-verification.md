# Compact reset-badge alignment — v0.3.8

The reported row reproduced with a 22px quota button and a 15px saved-reset button sharing their top edge, placing the balance text 3.5px above the quota text and provider mark.

The compact strip now gives its saved-reset button a 22px minimum height, matching the existing 14px provider mark plus the quota button's 4px vertical padding. The badge remains aligned to the first quota line when later windows, forecasts or notices are present. Other badge callers retain their existing sizing.

## Browser verification before release

The installed implementation passed 42 fixture combinations spanning early, known weekly, weekly/session, projected exhaustion, hidden constraints, unknown pace and confirmed exhaustion, at actual content widths of 172, 212 and 252px on desktop and mobile viewports.

Geometry assertions required positive element sizes and the requested content width. Maximum balance/provider-mark offset was 0px; first-line quota text also aligned. There was no visible-element horizontal overflow or page error. Desktop keyboard activation opened usage details and focused the matching reset inventory.

The existing jsdom suite does not perform CSS layout, so browser geometry—not a class-string assertion—was used as the regression surface. Mobile screenshot crops were unreliable during native-sidebar repositioning; mobile evidence is the positive-size geometry assertion rather than those crops.

## Release verification

- Applied only the alignment fix on top of remote main, without prototype artifacts.
- Updated package and npm-lock versions to 0.3.8; dependencies, compatibility ranges, settings and quota semantics are unchanged.
- TypeScript checking, all 305 application tests and 13 comment-policy regression tests passed.
- Built artifacts with BB 0.44.0 / SDK 0.5.29, preserving the existing release compatibility baseline. The compiled CSS contains the badge minimum-height utility.
- Production-only source installation with BB's bundled npm, artifact identity/version checks, host digest verification and isolated backend/host loading passed without authenticated provider requests.
- Package dry-run audit found 69 files and no prototype variants, switcher or server.
