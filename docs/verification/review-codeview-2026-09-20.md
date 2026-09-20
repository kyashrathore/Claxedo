# Pierre review document migration

Updated 2026-09-21. The user accepted the manually tested candidate and requested final spacing/hover fixes, complete removal of the replaced implementation, and merge into local `dev`. Editing remains out of scope.

## Ownership

`ReviewTab` supplies content and interactions. `ReviewCodeView` delegates document geometry, visible rendering, measurement, and item release to Pierre `CodeView`. The exact dependency pin is `@pierre/diffs` 1.4.3 with its native custom-item/lifecycle patch persisted in the repository.

Expand all changes expansion state. Content uses the canonical cache and a shared four-concurrent text/media queue, visible-first loading, and bounded lookahead. Unfetched content, errors, and retries are explicit. Parsed diffs are cached by content identity. Headers, media, annotations, editors, and gutter controls follow rendered-item lifetime; draft/selection state survives DOM release. Large-diff controls, split/unified mode, semantic scroll restoration, and held file/comment reveals remain supported.

Final cleanup matches tight row spacing and uses small local hover/focus state. The old renderer, outer virtualizer, spacers, independent height estimates, comparison switch, and separate hover helper are removed rather than kept as parallel implementations.

## Performance evidence

The existing `agent-app-benchmark` workspace-panel scenario ran against package2, which includes the shared media queue fix: **3 repetitions, 72/72 valid observations**; result validation passed. The archived baseline has **5 repetitions, 120/120 valid observations**, dated September 2. Corpus/scenario digests match. No scrolling benchmark ran, as requested.

| Action | Light | Moderate | Heavy |
|---|---:|---:|---:|
| open-panel | 132.5 → 131.1 | 132.5 → 135.5 | 133.6 → 129.6 |
| close-panel | 154.7 → 146.0 | 154.7 → 147.0 | 154.0 → 149.2 |
| files-to-review | 11.1 → 11.6 | 12.1 → 11.4 | 11.5 → 14.7 |
| review-to-files | 13.4 → 12.5 | 13.9 → 14.8 | 21.5 → 24.8 |
| open-file | 22.0 → 21.4 | 29.7 → 29.3 | 31.2 → 29.8 |
| switch-file-tab | 21.9 → 20.5 | 21.6 → 20.9 | 21.4 → 21.4 |
| expand-all | 38.8 → 18.0 | 38.4 → 20.3 | 40.6 → 22.7 |
| collapse-all | 13.3 → 32.4 | 13.3 → 44.6 | 13.4 → 46.0 |

Values are median milliseconds, baseline → candidate. Collapse-all was slower, and this was reported before the user authorized final cleanup and merge. OS, framework/driver revisions, and background conditions differ; this historical comparison does not isolate CodeView or establish no regression. Measurements predate final spacing/hover cleanup and unconditional cutover. No further performance run was requested.

Raw evidence: `.artifacts/end-to-end/workspace-panel-candidate-2-r3/{result.json,report.md}`. Result digest: `6d0cca2a25ed2588a9f240abb2c3043f61b3acaacfd81538c9df470fb7589be4`. Framework: `f8cc01d828928c75054f272fea48696c938781d4`. Registration now verifies the installed pin and invokes the framework's canonical CLI. Deferred traversal experiments remain outside the merged implementation.

## Verification

Final cutover checks:

- `bun test src` in `packages/session-ui`: 331 passed.
- `bun run typecheck` in `packages/session-ui`, and `bunx tsgo -b` in `packages/claxedo-app`: passed.
- `bun test --conditions=browser --preload ./happydom.ts ./src/features/review` in `packages/claxedo-app`: 64 passed after deleting tests for removed helpers.
- `bun run test:architecture-ratchets` at the repository root: passed (13 tests, 5 products / 8 source policies, helpers ratchet). Existing module ceilings are unchanged. Media classification now belongs to the existing review content-request policy rather than a separate wrapper module.
- Focused benchmark registration, pin, driver, and heavy-workspace contract tests: 29 passed; `bun run typecheck` in `packages/claxedo-app/perf-harness` passed.
- Repository search found no old `reviewWindowSegments`, `review-row-hover`, `ClaxedoSessionReview`, renderer flag, or old-loader production path. `git diff --check HEAD` passed.

- `bun run test:vitest src/features/review/ui src/app/workbench/review/review-scroll-restoration.vitest.ts` in `packages/claxedo-app`: 55 passed across 7 files. Tests observe the real engine through a test-only setup spy after removal of the production debug global; scroll-offset assertions remain intact. Repeated rendering applies a reveal once; a new request for the same file applies again.

The full app `bun run typecheck` command was also attempted. Its architecture phase fails on pre-existing debt, so it does not reach all downstream checks. After fixing this change's size/orphan/cast/state issues, the affected guards retain five baseline failures: existing message-timeline/session-controller size ceilings; directory-string, module-scope-state, and untrack counts; and the existing bootstrap test's unjustified cast. Comparing all production debt metrics against clean HEAD produced no differences. Standalone app TypeScript checking passes. No baselines or ceilings were raised.

Tests do not imply exhaustive packaged acceptance of every interaction.

## Final packaged UI

Unsigned macOS ARM64 package built with `CSC_IDENTITY_AUTO_DISCOVERY=false bun run package:mac --dir --publish never -c.mac.identity=null -c.mac.notarize=false`, without a renderer flag. Exit 0; packaging invariants passed. The final app launched against the same saved manual-test profile.

A focused UI check measured five consecutive row gaps at **2px**. At a viewport with overflow, one 100px wheel movement changed `scrollTop` from 0 to 100 and cleared the active hover row (1 → 0); pointer movement rearmed it (0 → 1). The initial full-height viewport fit all collapsed rows, so it could not exercise scrolling; the check used a shorter viewport and restored it afterward. This was a bug check, not a performance benchmark. Evidence: `.artifacts/end-to-end/final-ui-check.json`, `final-review-ui.png`, and `opus-package-final.log`.
