# Claxedo App Performance Budgets

This file records directional timing budgets for the app-shell rewrite. These
numbers are tracking targets, not hard CI thresholds; structural performance
invariants are enforced by `packages/claxedo-app` `test:performance`.

## Reference Machine

- Name: `Yashvardhans-MacBook-Pro-3.local`
- OS: Darwin 25.2.0 arm64
- CPU: Apple M4 Pro
- Memory: 25,769,803,776 bytes
- Measurement date: 2026-06-04 15:17:54 IST

## Budget: Structural Performance Gate

Command:

```sh
cd packages/claxedo-app
/usr/bin/time -p bun run test:performance
```

Measured result:

- `real`: 2.21s
- `user`: 3.77s
- `sys`: 1.35s

Retest on 2026-06-05 after the app-shell rewrite slice:

- Cold-ish run: `real`: 3.49s, `user`: 6.96s, `sys`: 2.32s
- Warm repeat: `real`: 2.77s, `user`: 5.48s, `sys`: 1.75s

Interpretation: the structural gate still passes, but these timings do not prove
a performance improvement over the earlier reference. Treat the current timing
budget as an at-risk tracking metric until repeated before/after measurements
show the expected rewrite delta.

Perf harness retest on 2026-06-05:

- `cd packages/claxedo-app/perf-harness && bun run typecheck`: pass.
- `cd packages/claxedo-app/perf-harness && bun run test`: pass, 7 tests.
- `bun run compare -- --output deterministic-compare-2026-06-05.json`: pass,
  26 deterministic Claxedo/upstream scenario runs.
- 2026-06-06 IST repeat:
  `bun run compare -- --output deterministic-compare-2026-06-06.json`: pass,
  26 deterministic Claxedo/upstream scenario runs, written to
  `packages/claxedo-app/perf-harness/reports/deterministic-compare-2026-06-06.json`.
  This repeat keeps the deterministic before/after harness healthy and records
  fresh trend rows for both targets. It still does not close the broad rewrite
  performance gate: Claxedo wins several interaction metrics
  (`long-session-switch`, `session-switch-stress`, terminal switching, and
  agent-control navigation), while launch/memory and several broad render paths
  still favor upstream or tie.
- 2026-06-06 browser harness reliability follow-up:
  per-scenario browser crashes are now preserved as failure rows with
  attribution, video artifacts, current URL/title/body excerpt, page/console
  errors, and failed response URLs. This exposed an upstream dev-server blocker:
  `packages/app` declared `@claxedo/*` in `tsconfig.json` but its Vite config did
  not alias that path, so upstream browser runs served 500s for modules such as
  `/src/utils/server-health.ts` and `/src/pages/directory-layout.tsx`. Adding the
  Vite alias in `packages/app/vite.js` made
  `browser-upstream-launch-after-alias-2026-06-06.json` pass
  `launch-empty-home` with no failures.
- 2026-06-06 browser Claxedo/upstream comparisons after the alias fix still do
  not prove the expected broad rewrite win. `browser-live-terminal-both-after-alias-2026-06-06.json`
  shows Claxedo faster on terminal surface switch (`51.70ms` versus upstream
  timeout `5000ms`) and PTY attach (`0.88ms` versus `1.18ms`), but upstream
  remains faster on terminal resize, reconnect, and ANSI render. `browser-large-diff-both-after-alias-2026-06-06.json`
  shows Claxedo faster on diff toggle (`118.30ms` versus `2022.57ms`) and
  slightly faster on hunk render (`49.62ms` versus `52.07ms`), but upstream
  remains much faster on VCS load (`23.84ms` versus Claxedo `671.74ms`),
  line-comment latency (`14.50ms` versus `40.50ms`), and changed-file navigation
  (`18.45ms` versus `124.71ms`). Treat these reports as directional evidence and
  keep the rewrite performance gate open.
- 2026-06-06 app-side large-diff follow-up: `ReviewTab` now bounds initial
  changed-file expansion to a viewport-sized batch instead of setting
  `openDiffs` to the entire 500-file summary. Focused review navigation still
  opens an out-of-batch target file, and navigation to an already-open file no
  longer collapses the current visible batch. Helper coverage lives in
  `src/claxedo-ui/components/review-open-diffs.test.ts`, and the review VCS audit
  rejects the old `setStore("openDiffs", files)` pattern. Browser report
  `browser-claxedo-large-diff-bounded-focus-2026-06-06.json` records
  `vcs_load_ms` `601.68ms`, `hunk_render_ms` `42.46ms`,
  `diff_toggle_latency_ms` `48.28ms`, `line_comment_latency_ms` `76.90ms`, and
  `changed_file_navigation_ms` `85.71ms`. Compared with
  `browser-large-diff-both-after-alias-2026-06-06.json`, this improves VCS load
  and diff-toggle latency but does not clear the strict browser budgets, and
  line-comment latency remains noisy.
- 2026-06-06 review-panel toggle follow-up: `WorkspacePanel` no longer unmounts
  the selected workspace tool body when the panel closes. The body is cached by
  mode/target/focus/navigator identity and intentionally excludes the `open`
  flag, so close/reopen hides and reveals the same ReviewTab tree instead of
  rebuilding the review and changed-file navigator. `WorkspacePanel.vitest.tsx`
  now proves close/reopen does not remount or cleanup the selected workspace
  tool. Live browser inspection after reload on the terminal route saw the
  review body mounted, but browser automation timed out when clicking the
  top-bar close control, so the exact perceived click latency still needs manual
  confirmation in the visible app.
- 2026-06-06 panel-shell measurement/fix follow-up: the browser harness now
  measures workspace-panel shell open from in-page click dispatch instead of
  charging automation control lookup to the app, and the VCS summary fixture no
  longer includes full patch/before/after payloads for `content=summary`.
  Claxedo state persistence is debounced off the interaction path and the hidden
  `WorkspacePanel` keeps its resting width while translated offscreen instead
  of collapsing to `0px`. Focused reports
  `browser-claxedo-large-diff-click-dispatch-2026-06-06.json` and
  `browser-claxedo-large-diff-resting-width-2026-06-06.json` record initial
  panel shell open at roughly `7-8ms`. The gate remains open because mounted-diff
  reopen still measures around `399-403ms`, VCS/content readiness remains around
  `448-483ms`, and changed-file navigation remains around `25ms`.
- 2026-06-06 panel phase/file-tree follow-up: the harness now records
  `review_panel_reopen_baseline_frame_ms`, `review_panel_reopen_click_ms`,
  `review_panel_reopen_state_ms`, and `review_panel_reopen_frame_ms`.
  Focused reports through
  `browser-claxedo-large-diff-contained-panel-shell-2026-06-06.json` show cheap
  click/state work (`~3ms` and `0ms`) and healthy baseline frames (`~7ms`), but
  the first visual frame after reopening over a mounted large diff remains
  around `223-237ms`. `WorkspacePanel` now hides retained header/body with
  `display:none` until after shell paint, keeps shell width/custom-property
  values stable while closed, removes the blurred panel shadow, and applies CSS
  containment. File explorer first render is now bounded via `FileTree`
  `visibleLimit`, with the workspace-panel Files navigator capped at 24 rows
  per directory before a show-more row. Empty loading directories now render a
  lightweight skeleton instead of a blank panel. The workspace-switch browser
  harness now separates panel/skeleton visibility (`file_tree_load_ms`) from
  actual row readiness (`file_tree_data_ms`). Focused evidence
  `browser-claxedo-workspace-filetree-process-provider-deferred-2026-06-06.json`
  still misses `file_tree_load_ms` at `59.70ms` (`control` `25.20ms`, `state`
  `18.40ms`, first frame `16.00ms`), while rows arrive after shell visibility in
  `13.00ms`. This remains an open perf item.
- Browser `session-switch-stress`: pass, `surface_switch_latency_ms` p95
  `64.60ms`, `session_switch_max_call_stack` `0`,
  `session_switch_loader_fraction` `0.19`; final frame shows
  `OpenCode` / `Build` / `Claude Opus 4.6`.
- Browser `bootstrap-pending-storm`: pass, pending requests `0`, drain `606ms`.
- Browser `burst-authed-fetches`: pass, failures `0`, drain `44ms`.
- Browser `long-session-switch`: original retest failed at `669.65ms` over the
  existing `523ms` browser budget, but follow-up investigation found the harness
  was charging two fixed video-settle sleeps to the timed latency path. After
  moving latency scenarios to frame-only settling and keeping video stabilization
  outside the timed section,
  `browser-claxedo-long-session-switch-frame-settle-2026-06-05.json` passes at
  `151.02ms`; the all-browser Claxedo rerun records the same scenario at
  `154.39ms`.
- Browser `launch-project-20-sessions`: the same click-settle correction moved
  transcript switch work from roughly `653ms` to `131.71ms`, but the stored
  browser budget is still `45ms`. Treat this as a remaining calibration/perf
  item rather than proof that the broad perf gate is closed.
- Browser `live-terminal-switch`: previous aggregate runs timed out at roughly
  `5s` because the harness waited for terminal panel dimensions to change after
  switching terminals. The app can swap terminal content without changing panel
  geometry, so the harness now waits for visible terminal stability and records a
  timeout as a visual failure. Focused evidence
  `browser-claxedo-live-terminal-switch-visible-settle-2026-06-05.json` passes at
  `31.50ms`; the aggregate rerun records `13.50ms`.
- Browser `command-palette-large-project`: open/search helpers also charged fixed
  video-settle sleeps to timed metrics, and command execution mixed Enter
  dispatch with terminal surface navigation. Browser latency paths now use
  frame-only settling, and `command_execution_overhead_ms` measures dispatch/frame
  work only. Focused evidence
  `browser-claxedo-command-palette-dispatch-frame-2026-06-05.json` improves
  open/search/execution from roughly `286ms`/`284ms`/`648ms` in the aggregate run
  to `48.59ms`/`41.34ms`/`111.29ms`. Search now clears its stored `43ms` browser
  budget; open and dispatch remain over stale `8ms`/`7ms` budgets.
- Browser `large-diff-toggle`: review scroll, diff toggle, line click, and
  changed-file navigation now avoid fixed video settles and Playwright locator
  waits in timed paths where possible. A stricter changed-file wait briefly
  inflated aggregate `vcs_load_ms` to `20s`; the harness now separates
  review-surface opening from changed-file validation and targets the
  viewport-visible workspace-panel control by exact label. Focused evidence
  `browser-claxedo-large-diff-exact-panel-2026-06-05.json` opens the review
  surface without visual failures, but still misses budgets: `vcs_load_ms`
  `668.37ms`, `hunk_render_ms` `50.83ms`, `diff_toggle_latency_ms` `131.14ms`,
  `line_comment_latency_ms` `1291.32ms`, and `changed_file_navigation_ms`
  `59.08ms`. Follow-up evidence
  `browser-claxedo-large-diff-stable-line-comment-2026-06-05.json` adds an idle
  boundary between diff toggle and line-comment timing, dropping
  `line_comment_latency_ms` to `88.70ms`; the scenario still misses budgets with
  `vcs_load_ms` `664.11ms`, `hunk_render_ms` `56.74ms`,
  `diff_toggle_latency_ms` `113.62ms`, and `changed_file_navigation_ms`
  `54.16ms`. Follow-up harness isolation moved review-scroll setup out of
  `hunk_render_ms` and uses keyboard-only diff toggling between stable review
  frames. Current evidence
  `browser-claxedo-large-diff-scroll-boundary-2026-06-05.json` records
  `vcs_load_ms` `642.92ms`, `hunk_render_ms` `53.74ms`,
  `diff_toggle_latency_ms` `97.29ms`, `line_comment_latency_ms` `79.20ms`, and
  `changed_file_navigation_ms` `51.34ms`. Treat this as a remaining app-side or
  budget-calibration item.
  2026-06-06 follow-up: browser validation now accepts cached/prefetched session
  data when the scenario records its expected transcript as visibly rendered,
  instead of requiring the legacy `/session/:id/message` request counter to
  increment. Targeted evidence
  `browser-claxedo-large-diff-targeted-2026-06-06.json` has no validation
  failures and reports the remaining metric misses as `vcs_load_ms` `659.20ms`,
  `hunk_render_ms` `48.44ms`, `diff_toggle_latency_ms` `51.09ms`,
  `line_comment_latency_ms` `75.20ms`, and `changed_file_navigation_ms`
  `38.13ms`.
  Follow-up: explicit `--scenario` now takes precedence over the browser
  package script's built-in `--all`, so focused reruns such as
  `bun run browser -- --target claxedo --scenario large-diff-toggle` execute one
  scenario instead of the whole browser suite. Verification report
  `browser-claxedo-large-diff-focused-script-2026-06-06.json` contains one
  `large-diff-toggle` run with no validation failures, but still misses strict
  browser budgets at `743.47ms` / `56.50ms` / `1189.84ms` / `99.60ms` /
  `41.53ms` for load, hunk render, diff toggle, line comment, and changed-file
  navigation respectively.
  Follow-up: review diff-style toggling now has a scoped `d` keyboard shortcut
  and a nonvisual `data-review-diff-style` marker, letting the browser harness
  wait for the real state transition rather than timing an unowned keypress. The
  review-stability boundary also includes visible line geometry. Focused report
  `browser-claxedo-large-diff-stable-key-toggle-2026-06-06.json` still fails,
  but records no validation failures and current values of `689.53ms` /
  `50.92ms` / `88.59ms` / `37.90ms` / `123.60ms`.
  Follow-up: changed-file navigation now targets the actual workspace-panel
  changed-files navigator using stable navigator/row selectors instead of a
  broad file-row locator that could click review content. Report
  `browser-claxedo-large-diff-navigator-target-2026-06-06.json` has no
  validation failures and records `673.04ms` / `53.86ms` / `138.07ms` /
  `67.50ms` / `56.00ms` for load, hunk render, diff toggle, line comment, and
  changed-file navigation respectively. The scenario still fails all strict
  browser budgets (`36ms`, `41ms`, `37ms`, `33ms`, and `7ms`), so treat this as
  better measurement fidelity rather than a closed perf gate.
  Follow-up: large-diff panel opening now has separate shell metrics:
  `review_panel_open_ms` and `review_panel_reopen_ms`. The workspace panel is an
  absolute right-edge overlay, paints a lightweight shell before hydrating its
  header/body, and keeps mounted review content hidden from the first shell
  paint on open/reopen. Focused report
  `browser-claxedo-large-diff-panel-shell-delayed-body-2026-06-06.json` recorded
  initial shell open around `59.81ms`; broad diff readiness remains separate and
  still failed (`vcs_load_ms` `535.72ms`, changed-file navigation `24.50ms`).
  Follow-up: `ReviewTab` now eagerly warms full content for the initially-open
  small-file batch after the summary diff resolves, using the existing
  `review-vcs-file` query cache and skipping already-loaded or oversized diffs.
  Focused report `browser-claxedo-large-diff-eager-initial-content-2026-06-06.json`
  still fails strict budgets, but isolates the remaining slow leg to summary/VCS
  readiness (`vcs_load_ms` `648.69ms`) while hunk render and line-comment work
  are low (`34.15ms` and `11.50ms`).
- Browser `workspace-switch`: workspace inventory, workspace click, file panel,
  and session-inventory helpers now use frame-only settling for timed latency
  paths. Focused evidence
  `browser-claxedo-workspace-switch-frame-inventory-2026-06-05.json` moves
  workspace switch from roughly `1279ms` to `285.09ms` and surface switch from
  roughly `334ms` to `12.50ms`; workspace switch itself now clears its stored
  `709ms` browser budget. The latest aggregate
  `browser-claxedo-all-workspace-timing-2026-06-05.json` records workspace switch
  `260.32ms`, file tree `133.24ms`, and surface switch `24.74ms`.
- Browser `three-pane-resize`: the review opener now uses the visible
  `Open workspace panel` chrome control before falling back to a shortcut, and
  review-surface validation accepts the workspace review root selectors. Focused
  evidence `browser-claxedo-three-pane-workspace-panel-toggle-2026-06-05.json`
  passes all metrics and the review-surface validation. The latest aggregate
  `browser-claxedo-all-three-pane-fixed-2026-06-05.json` records this scenario
  as fully passing (`frame_time_ms` `8.30ms`, terminal resize `36.50ms`, diff
  toggle `1.27ms`).
- Full Claxedo browser suite retest
  `browser-claxedo-all-three-pane-fixed-2026-06-05.json`: 13 scenarios ran, 9
  passed, 4 failed. Remaining failing scenarios are
  `launch-project-20-sessions`, `large-diff-toggle`, `workspace-switch`, and
  `command-palette-large-project`. Several failures use
  stale/tiny browser budgets, so the
  suite still needs calibration and/or targeted app fixes before it can prove the
  expected rewrite delta.

The harness now writes attribution metadata into reports/trends: git SHA,
branch, dirty state, command, cwd, Bun version, OS/platform, target package,
browser version for browser runs, server URL/port, app build identity, and
scenario seed.

Directional budget:

- Keep `real` under 3.50s on the reference machine for the current structural
  gate.
- Re-baseline this budget when adding new structural performance scenarios.
- Do not treat a slower single run as a release blocker until repeated runs show
  sustained drift; this budget is for trend tracking while timing stabilizes.

Covered structural scenarios:

- 10k-row chat timeline reference reuse on token/update changes.
- Virtual timeline row render boundary.
- Directory scope bootstrap gating.
- Workbench hidden-content mount retention.
- Workbench focused-content reactivity.
