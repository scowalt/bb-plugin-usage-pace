# CI

## Native Linux routing

The workflow selects `ci_os: linux`, matching the supported Woodpecker 3.19
agent setting `WOODPECKER_AGENT_LABELS=ci_os=linux`. Before merging this change,
the parent must configure and read back that label and actual Linux ARM64
platform on the current agent, then verify the label and Linux AMD64 platform
on its replacement. Include no other OS or unsupported CPU; retain native platform
reporting. This routing label is not a security boundary or hardware attestation.
The original image index supports both targets, without a matrix or emulation.
ARM64 rollout guidance below is historical, not native AMD64 proof. Commands,
pins and status layout stay unchanged; actual AMD64 acceptance is separate.

## Authored contract

`.woodpecker.yaml` ports only `.github/workflows/no-comments.yml`: job
`no-comments` in workflow `Comment-free source`. Both original commands run in
order, fail closed, and need no job secrets:

```sh
uv run --no-project --python 3.14 --with-requirements .comment-policy/requirements.txt python .comment-policy/check.py
uv run --no-project --python 3.14 --with-requirements .comment-policy/requirements.txt python -m unittest discover -s .comment-policy -p 'test_*.py'
```

The original Actions job uses `ubuntu-latest`, a 10-minute timeout, read-only
contents permission, checkout `11d5960a326750d5838078e36cf38b85af677262`,
and setup-uv `d0d8abe699bfb85fec6de9f7adb5ae17292296ff` with uv `0.11.32`
and caching keyed by `.comment-policy/requirements.txt`.
Woodpecker uses the approved Linux ARM64/AMD64-capable Python 3.14 / uv 0.11.32
Trixie image pinned by digest in the pipeline. Its disposable environment uses
uv's normal dependency cache, not the Actions cache service.
The five unchanged requirement pins are tree-sitter `0.25.2`,
tree-sitter-language-pack `0.13.0`, tree-sitter-c-sharp `0.23.5`,
tree-sitter-embedded-template `0.25.0`, and tree-sitter-yaml `0.7.2`.

Actions has unfiltered `push` and `pull_request` triggers, without branch or
path restrictions. Native `push`, `tag`, and `pull_request` preserve that scope,
including tag pushes. Fork PRs remain approval-gated. Configured event coverage
is not evidence that a tag or fork event has actually executed.

Keep the native default clone and real Git index. The checker enumerates tracked
and non-ignored new files via Git; the unchanged pre-commit hook checks the
complete staged index with `--staged`, not just changed paths. Preserve all
existing exclusions and all 13 regression tests. Neither hosted command needs
history, all refs, submodules, application dependencies, or provider data; a
current checkout with Git metadata is sufficient. No custom clone is needed.

The README's TypeScript/application tests, BB builds, production-only install
checks, release smoke checks, generated bundles and tagging remain local release
verification, not new hosted gates. Preserve their toolchain baseline
BB 0.44.0 / SDK 0.5.29, locks and hooks unchanged. This repository authors no
hosted publishing/deployment job or deployment controller configuration. CI must
not install/reload a live plugin or contact provider/account/reset/auth APIs.

## Parent-owned rollout

This source port does not activate Woodpecker or disable Actions. Use the existing
single CAX11 in hel1: ARM64, 4 GiB, capacity one, 2 GiB job limit. Do not add
capacity, secrets, privileges or infrastructure spend.

1. Complete separate source review and integration. The parent activates the
   exact repository using native supported interfaces, then reads settings back:
   pipeline path `.woodpecker.yaml` (or native default resolution), push/tag/PR
   hooks enabled, `require_approval: forks`, `approval_allowed_users: []`, and
   `trusted.network`, `trusted.volumes`, `trusted.security` all `false`. Set and
   read back repository `timeout: 10`, matching Actions; timeout is a repository
   setting, not a YAML key. Check that no repository/global job secrets or
   operator/admin/publishing/production credentials reach these jobs. Do not
   broaden trusted clone plugins, mount hosts/sockets, or enable privileged mode.
2. Deliver through ONE ordinary reviewed PR while Actions remains enabled.
   MC #26 / PR #29 already supplied the controlled RED-to-GREEN and same-PR
   post-disable proof once. Do not repeat deliberate failures, marker commits,
   extra test PRs, fresh tags/forks or per-target post-disable revisions.
   On the actual exact delivery head, retain native PR pipeline/clone/job success,
   both original command logs, the actual full-index policy count, all 13 tests,
   runtime pins and Linux ARM64 execution evidence, plus matching exact-SHA
   GitHub Woodpecker success. Local x86_64 lint is not hosted acceptance. Observe
   rather than invent the reported context; Actions run lists do not prove all
   third-party or protection requirements pass.
3. Merge normally with `gh pr merge --match-head-commit <reviewed-head>` and the
   repository's reviewed merge method. Record the ACTUAL resulting default
   `main` SHA, tree and ordered parents, retained original workflow blob, native
   push clone/job success and matching exact-SHA GitHub success. A green PR head
   alone is insufficient. Only after this resulting-main proof replace any
   corresponding Actions requirement with the observed Woodpecker result,
   preserving unrelated protection/rules/checks. Empty protections/rules/required
   checks mean a replacement NOOP, not permission to invent or remove anything.
   Then change only GitHub Actions `enabled` to `false` and read it back.
4. Perform a separate fresh GET-only acceptance: verify the exact main identity,
   native PR and resulting-main successes, GitHub results, settings and unchanged
   original files. Record a bounded UTC observation interval and Actions run list
   showing no new Actions runs in that interval. Create no fresh post-disable
   event; absence without one does not prove future event handling or infinite
   absence. Keep a short repository/result entry in the parent rollout record.

If credentials, platform, history, capacity or native proof is unavailable, stop
and record the precise blocker; leave Actions enabled rather than weakening
coverage. Rollback leaves the original Actions workflow byte-identical: re-enable
Actions, restore only the exact previous corresponding requirements from the
parent's saved readback, and pause/deactivate the replacement if necessary.
Do not change deployment, plugin runtime, generated artifacts or unrelated rules.

## Local preparation

Run both commands above independently, then stage only the two CI files and run
the full staged-policy snapshot. Install the existing hook with
`lefthook install pre-commit`, run redacted Gitleaks before committing, and make an
ordinary hooked commit. Keep evidence outside the repository.

Use checksum-verified Woodpecker CLI 3.19.0 for native schema validation, without
inherited credentials/config or API access:

```sh
home=$(mktemp -d)
env -i PATH="$PATH" HOME="$home" woodpecker-cli --disable-update-check lint --strict .woodpecker.yaml
rm -r "$home"
```

See the [native workflow syntax](https://woodpecker-ci.org/docs/usage/workflow-syntax),
[3.19.0 schema](https://github.com/woodpecker-ci/woodpecker/blob/v3.19.0/pipeline/frontend/yaml/linter/schema/schema.json),
[clone contract](https://woodpecker-ci.org/plugins/git-clone), and
[repository settings](https://woodpecker-ci.org/docs/usage/project-settings).
Source/local success is not ARM64 hosted acceptance or migration completion.
