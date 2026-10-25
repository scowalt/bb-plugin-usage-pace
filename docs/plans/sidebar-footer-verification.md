# Sidebar footer migration — 0.4.4

## Problem and contract

bb 0.47 moved macOS page/thread headers into the title bar. In its framed sidebar, `AppSidebar.tsx` makes the footer a fixed 48px chrome row, vertically centred. Usage Pace 0.4.3's `mountBarHost` inserted the entire strip as the first child of `div[data-sidebar="footer"]`. That DOM element is not a plugin API. A strip taller than the row overflowed above and below it: account rows were behind the thread list and bb's footer buttons were below the window. A browser tab's unframed footer still grew to fit.

Use the SDK 0.5.29 `app.experimental_sidebarFooter.register` disclosure contract, available since bb 0.42. bb owns the icon, disclosure arbitration, bordered card, 320px scroll limit, placement, and keyboard/focus behavior. No selector, DOM observer, resize observer, or insertion into bb's footer remains in the strip implementation. The separate Provider usage card content script is intentionally unchanged.

## Implementation and lifetimes

- Read the public plugin settings endpoint before synchronous app setup (five-second timeout, fail closed). With `showStrip` off, register no footer item. The SDK has no unregister API; changing `showStrip` needs a UI reload to add/remove the icon. No backend RPC/contract or dependency pin is added for this.
- Register one `disclosure`, `usage-strip`, labelled Usage Pace with a ChartLine icon; call its controller's `open()` only during setup. Never reopen from a timer, focus, visibility, data update, or component remount. bb allows one disclosure across all plugins and does not persist its selection across reloads.
- The disclosure mounts a plugin-owned ref container. The existing overlay portals the strip into that container, retaining one shared saved-reset provider for the strip and dialog. Ref removal on disclosure close clears it; `active` now means the actual disclosure or dialog is open, not the continued presence of a node injected into bb's footer.
- Quota polling belongs to the always-mounted overlay, independent of disclosure visibility. Keep five-minute visible-page polling and focus/visibility refresh. The reset refresh/deduplication also lives there, so closing the disclosure cannot prevent a reset refresh. Disabling `showStrip` stops that polling; changing registration still requires UI reload.
- Preserve the compact account/pool order, pace hierarchy, badges, dialog, server-only filter, CLI, and Provider usage integrations. Add only small card padding, keeping host tokens and container-responsive rows; bb supplies the outer border and scrolling.

## Verification boundary

Work starts on a new branch from `origin/main` = `abe551ced35a827d2d92041b2b798ec20790dc96` (v0.4.3). All edits are in this task's worktree. Neither real bb server is installed into, reloaded, reconfigured, restarted, or stopped; no real threads are started or messaged. No other repository is changed.

A disposable npm `bb-app@0.47.1` server uses a separate temporary data directory and isolated HOME/environment, no host daemon or provider credentials. A temporary discoverable `provider-usage.v1` source serves four synthetic accounts (Claude A/B, Codex, opencode), yielding five strip rows including the Claude pool. All addresses end in `example.test`; no real account data is used. `serverOnly=true` exercises shared-source filtering without a real machine login. No screenshots contain real identities.

The server runs through Portless with private Tailscale sharing and an allocated backend port, not a common fixed port or public tunnel. bb's single configured-host guard permits the private URL and rejects the `.localhost` proxy hostname; both endpoints were checked. Browser Automation could not find Chrome; disposable Puppeteer 24.15.0 / Chromium 138 supplies the check instead. Before page scripts, the user-provided `window.bbDesktop` bridge stub enables macOS framing; `[data-framed]` must be present. Ordinary tabs omit the stub and must not be framed.

**Bridge correction:** the exact generic proxy reproduces the reported footer failure, but it also returns functions for missing numeric `macosTrafficLightInset` and `macosTrafficLightTopInset` properties. bb 0.47.1 then computes a `NaNpx` title-bar height, introducing an unrelated short-sidebar layout. For the comparable final before/after runs, add this `get` branch after `platform`:

```js
if (key === "macosTrafficLightInset" || key === "macosTrafficLightTopInset") return undefined;
```

That leaves both properties absent, allowing the shipped UI's defaults (17px and 15px) to produce a valid 44px title bar. No bb code, CSS, or layout node is patched. Both versions use this identical corrected bridge; the 48px-footer bug still reproduces on 0.4.3.

## Regression evidence

The agreed seam is the actual app setup and content-script/overlay lifecycle, with the external SDK registration boundary and HTTP responses faked. Production store, polling, strip, and reset provider are real. The live run separately verifies host layout and cross-plugin arbitration, which the unit fake cannot establish.

```sh
bunx --no-install vitest run sidebar-footer.test.tsx -t 'opens one sidebar footer'
```

- **Before:** final test/config copied over a pristine archive of `abe551c`, production `app.tsx` and `lib/usage-store.ts` compared byte-for-byte with that commit: **1 failed, 4 skipped**. It observes zero disclosures, zero `open()` calls, and the injected `usage-pace-bar-host` inside bb's footer. [Full failing output](sidebar-footer/regression-before.txt).
- **After:** identical test/command: **1 passed, 4 skipped**. One disclosure, one startup open, original footer HTML untouched, no injected host. [Full passing output](sidebar-footer/regression-after.txt).
- All five new lifecycle tests pass: startup registration/open/no injection; `showStrip=false` registers nothing and does not poll quota; five-minute/focus/visibility refresh continues with disclosure closed without reopening it; passed-reset force refresh still runs once while closed; saved-reset reads start/stop with the actual disclosure/dialog, sharing badges and never reopening the card. Timers are disposed after unmount.
- A fresh live browser page with `showStrip=false` also has no Usage Pace footer item, strip, or injected host.

### PR #9 checks repeated

| Check | Result |
| --- | --- |
| Bun 1.3.11 / Node 24.20.0; `bun install`, frozen lockfile install | Passed; dependencies and Bun lock unchanged. |
| `bun run check` | Passed. |
| `bun run test` | 411 Vitest tests in 19 files plus 3 token-total tests passed. |
| `bun run build` | Passed with separate BB 0.44.0 / SDK 0.5.29 through `BB_CLI`; all three artifact versions are 0.4.4. |
| `bun run check:install` | Passed with Bun and again with BB's npm 11.16.0; isolated production-only builds. |
| `bun run check:release` | Passed with BB's npm and actual SDK runtime: versions, metadata, digest, isolated backend/host smoke loading; no provider requests. |
| Both exact CI.md uv/Python policy commands | 113 files checked, zero violations; all 13 policy regressions passed. The complete staged-index snapshot and existing Lefthook pre-commit hook also passed; redacted Gitleaks found no leaks. The existing shared Git hook is reused without reinstalling or changing the user's old checkout. Exact-head hosted results are recorded in the PR. |
| Woodpecker CLI 3.19.0 strict lint | Passed under `env -i` with temporary HOME; archive checked against the official release SHA-256 list, then extracted. No API/credential/config use. |
| Frontend mechanical detector | No findings in `app.tsx`. |
| PR #9 synthetic component fixture | Six server/all-host strip cases at 172/212/252px and four 1200/375px dialog cases passed, using real components and rebuilt CSS. Stale B, healthy A/Codex, failed opencode, partial pool, one matching reset badge and actual reader remain correct. No horizontal overflow, zero-sized controls, redundant headings, or page errors. |
| `git diff --check` | Passed. |

## Live evidence

The throwaway instance installs 0.4.3 from pristine `abe551c`, then 0.4.4 from a separate disposable copy. For the final after run, the release-toolchain `dist/` is copied into that disposable copy after bb's install-time rebuild. The app asset response is verified byte-identical to the release `dist/app.js` (SHA-256 `702393e4edeb1069c43eeb2b94c874110e481dc59634daefc433d81b6f2689e1`). No reload rebuild can overwrite the release worktree.

Measurements below are CSS-pixel y ranges. Rows are A, B, Claude pool, Codex, opencode. A centre hit means `elementFromPoint` returned that row or its descendant, not an overlaid sibling. Footer controls include Mobile apps, Provider usage, Report a bug, More, plus Usage Pace after migration.

| Mode / viewport | Before: strip / footer controls | Before row centre hits | After: strip / footer controls | After row centre hits |
| --- | --- | --- | --- | --- |
| macOS framed, 1440×900 | 737.38–954.63 / 966.63–998.63 | no / no / yes / no / no | 627.75–845 / 852–884 | all five |
| macOS framed, 1440×600 | 437.38–654.63 / 666.63–698.63 | no / no / yes / no / no | 327.75–545 / 552–584 | all five |
| Browser tab, 1440×900 | 631.75–849 / 861–893 | all five | 636.75–854 / 861–893 | all five |
| Browser tab, 1440×600 | 331.75–549 / 561–593 | all five | 336.75–554 / 561–593 | all five |

Before, the framed footer remains 48px but its strip overflows and A/B are obscured; only the pool centre is hit-testable. After, every complete row and every footer control is inside the window and hit-testable, with no injected footer node. The host's card supplies scrolling and a border, while the original compact rhythm and token colours remain. Empty states and dialog behavior are covered by component tests. In **all four after cases**, opening Provider usage removes the strip, and the Usage Pace icon restores it. No page errors occur.

Raw [before measurements](sidebar-footer/before-measurements.json) and [after measurements](sidebar-footer/after-measurements.json) include individual row/control rectangles and hit-test results.

| Viewport | Before screenshot | After screenshot |
| --- | --- | --- |
| macOS 1440×900 | [0.4.3](sidebar-footer/before-macos-900.jpg) | [0.4.4](sidebar-footer/after-macos-900.jpg) |
| macOS 1440×600 | [0.4.3](sidebar-footer/before-macos-600.jpg) | [0.4.4](sidebar-footer/after-macos-600.jpg) |
| Browser 1440×900 | [0.4.3](sidebar-footer/before-browser-900.jpg) | [0.4.4](sidebar-footer/after-browser-900.jpg) |
| Browser 1440×600 | [0.4.3](sidebar-footer/before-browser-600.jpg) | [0.4.4](sidebar-footer/after-browser-600.jpg) |

This verifies the real shipped web UI in Chromium's stubbed macOS desktop mode, not native AppKit behavior or real provider acceptance. After verification, Chromium is closed, the owned Portless process is stopped, its routes removed, and its backend no longer listens. The disposable instance/data directory is removed. The shared proxy and both real bb servers remain running and untouched.
