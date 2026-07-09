# Claxedo App Code-Organization Review — Appendix (2026-07-10)

Machine-generated from a 6-agent parallel organization review (read-only): root topology, claxedo-ui, components/pages/session, shell/context, support dirs, test placement.
Organization ONLY (placement, granularity, file naming, test location) — code-content findings live in 2026-07-10-003-claxedo-app-audit-findings-appendix.md.
Consumed by WP-ORG in 2026-07-10-002-refactor-claxedo-app-oss-quality-lld.md.


# root-topology

**Verdict:** The root package layout is a reasonable, OSS-appropriate structure (heavier README/AGENTS/CONTRIBUTING/RELEASING set than sibling packages, but justified since this package is the one slated to be open-sourced on its own). Root demo/ (a Vite HTML entry point, parallel to root index.html) and root e2e/ (real Playwright/Bun suites) are not duplicated by src/demo (demo-mode fixtures/handlers/tour logic) or src/e2e (a single lazy-loaded production route used only by an e2e spec) — different charters, correctly separated — except that src/e2e's name collision with root e2e/ is a real, fixable point of confusion (see misplaced). The src/ top level is not navigable at 28 directories: eight of them (analytics, constants, hooks, vite-shims, providers, pane, cloud, overrides) are single-file or single-concern directories that dilute the signal that "top-level dir = real subsystem," and one (overrides/) is a pure historical tombstone whose only content is a README saying not to use it. Inside the surviving large directories, components/ has already established a "cohesive group gets its own subdirectory" convention (prompt-input/, server/, session/) but applies it inconsistently, leaving ~18 dialog-* and ~9 settings-* files flat. The most consequential single find is a verified dead, zero-importer duplicate file (utils/local-selection-handoff.ts) sitting unnoticed in the already-overloaded 68-file utils/ dumping ground, plus a genuine one-letter directory-name collision (claxedo-ui/layout/ vs claxedo-ui/layouts/) that hides two unrelated concerns behind near-identical names. None of the proposed fixes here require touching the higher-risk "four homes for session logic" problem, which the companion quality audit already owns the direction for.

## Misplaced
- **[high]** `src/utils/local-selection-handoff.ts` → `delete — superseded by src/shell/session/local-selection-handoff.ts`
  Verified byte-for-byte near-duplicate (same exported shape, shell/session version has 2 additional exports) of src/shell/session/local-selection-handoff.ts. Confirmed zero importers of the utils/ copy anywhere in src/, while the shell/session/ copy is the one actually imported by context/local.tsx, claxedo-ui/claxedo-layout-actions/session-actions.tsx, and shell/session/session-config-selection.ts. This is dead fork-era duplication sitting unnoticed in the already-overloaded 68-file utils/ directory (not caught by the architecture orphan guard).
- **[medium]** `src/e2e/dialog-matrix-harness.tsx` → `src/pages/dialog-matrix-harness.tsx`
  This is a real production route (lazy-mounted in src/app.tsx at path /__e2e/dialog-matrix, aliased as @claxedo/e2e/dialog-matrix-harness) that happens to only be exercised by e2e/playwright/dialog-matrix.spec.ts. Its directory name is identical to the root-level e2e/ test-suite directory, so a contributor looking for 'the actual e2e tests' finds a route component instead, and a contributor looking for 'all app routes' won't think to check a directory named e2e/. src/pages/ already hosts other special-purpose routes (cli-login.tsx, config.tsx, error.tsx) and is the honest home for this one.

## Promote to directory
- **[medium]** `src/marketplace/marketplace-panel.tsx` → marketplace/marketplace-panel.tsx (thin composition root) + marketplace/{filters,cards,install-flow,detail-view}.ts
  1074 lines is the entire content of this top-level directory — a single undecomposed file. From the tree alone a contributor has no way to see that this one file contains an entire feature's filtering, card rendering, and install-flow logic; splitting it is also the pattern this same codebase already applies successfully elsewhere (e.g. session/submit/*, claxedo-ui/claxedo-layout-actions/*).
- **[medium]** `src/components/ (18 flat dialog-*.{ts,tsx} files: dialog-connect-integration, dialog-connect-provider, dialog-create-cloud-project(+test), dialog-create-cloud-workspace, dialog-custom-provider(+form), dialog-fork, dialog-manage-models, dialog-new-project, dialog-provider-stack, dialog-release-notes, dialog-select-directory(+routes+test), dialog-select-file, dialog-select-mcp(+logic+test), dialog-select-model(+unpaid), dialog-select-provider, dialog-select-server, dialog-settings)` → components/dialogs/{connect-integration,connect-provider,create-cloud-project,...}.tsx
  components/ already establishes the 'cohesive feature group gets its own subdirectory' convention for prompt-input/, server/, and session/ — but the ~18-file dialog-* cluster (by far the largest cohesive group in the directory) is left flat, so the convention is applied inconsistently within the same directory.
- **[medium]** `src/components/ (9 flat settings-*.{ts,tsx} files: settings-account-section, settings-connections(+core+test), settings-general, settings-keybinds, settings-list, settings-models, settings-providers, settings-sandbox-section(+helpers+test+vitest), settings-terminals(+test))` → components/settings/{account-section,connections,general,keybinds,list,models,providers,sandbox-section,terminals}.tsx
  Same convention gap as the dialog-* cluster: a clearly cohesive settings-panel feature group sits flat among 60+ unrelated sibling files in components/ instead of getting the same subdirectory treatment already given to prompt-input/, server/, and session/.
- **[low]** `src/components/ (titlebar.tsx, titlebar-history.ts, titlebar-project.ts, titlebar-v2-edit-icon.tsx(+vitest))` → components/titlebar/{index.tsx,history.ts,project.ts,edit-icon.tsx}
  Smaller version of the same pattern — a component plus its supporting logic scattered as flat same-prefix siblings instead of a folder; lower priority than the dialog/settings clusters purely because of size (5 files vs 18/9).

## Flatten / merge
- **[high]** `src/overrides/`: delete the directory; fold its historical/how-it-works content into CONTRIBUTING.md or docs/tech-docs/
  Contains only a README.md that states, in its own words, 'this directory is intentionally empty... do not add production .ts or .tsx files here.' A directory whose entire purpose is a sign reading 'nothing lives here' is a hard-fork tombstone left in the source tree; a first-time OSS contributor will reasonably assume there is a live override-injection mechanism to hook into and waste time investigating it.
- **[high]** `src/providers/ (claxedo-events.tsx + index.ts)`: merge into src/context/ (e.g. src/context/claxedo-events.tsx)
  src/context/ is the app's actual home for every other SolidJS context provider (73 files: global-sync, global-sdk, terminal, prompt, sdk, server, notification...). A second, one-file top-level 'providers' directory for a single provider (an SSE event bus) means 'where do providers live' has two answers with no documented distinction between them.
- **[medium]** `src/cloud/ (runtime/workspace-runtime-store.ts + 2 tests)`: merge into src/shell/data/ (workspace-runtime-store.ts sits naturally next to shell/data/global-bootstrap.ts, shell/data/session-inventory.ts) or src/shared/query/
  The app is explicitly multi-server/self-hostable, not cloud-only, yet this is the one top-level directory named 'cloud'. Its single file (workspace runtime status/reconnect tracking) is a generic workspace-runtime concern already imported by shell/data, session/store, and shared/query — the 'cloud' name implies a siloed concern that doesn't actually exist; real cloud-specific code (workspace-control-routes.ts, share-workspace.ts, convex-client.ts) instead sits under utils/.
- **[medium]** `src/pane/ (store/pane-preferences.ts, 106 lines)`: merge into src/claxedo-ui/state/pane-preferences.ts (colocate with rail.ts, workspace-panel.ts, terminal.ts — the rest of the pane/tab/workspace state slices)
  A single 106-line preference store is the entire justification for its own top-level directory, while the broader pane/tab state machinery it is used alongside (by session-client, claxedo-ui, session) already lives in src/claxedo-ui/state/. Splitting one small piece of that state into a sibling top-level dir gives no navigational benefit.
- **[low]** `src/analytics/ (posthog.ts, 1 file)`: merge into src/utils/analytics.ts
  Single-file top-level directory with no plausible near-term growth; joins a cluster of similar 1-file dirs (constants/, hooks/, vite-shims/) that dilute the signal that a top-level directory represents a real subsystem.
- **[low]** `src/constants/ (file-picker.ts, 1 file)`: merge into src/utils/file-picker.ts or src/shared/
  Single-file top-level directory; the file itself is a normal utility (accepted MIME/extension lists) with no distinct 'constants' pattern established anywhere else in the tree.
- **[low]** `src/hooks/ (use-providers.ts, 1 file)`: merge into src/context/use-providers.ts or src/utils/
  The file is a SolidJS hook that consumes @/context/sdk and shell query options — it reads as context-adjacent glue, not the start of a broader 'hooks' convention (no other hook files exist at top level).
- **[low]** `src/vite-shims/ (lru-map-default.ts, 1 file)`: merge into src/utils/lru-map.ts
  The file is a plain LRUMap polyfill class with zero Vite-specific code; it is only reached via a vite.cloud.config.ts resolve alias, so the directory name describes the wiring mechanism rather than the code's actual purpose, and it is the only file in the directory.

## File naming
- `src/claxedo-ui/claxedo-layout-actions.tsx (+ claxedo-ui/claxedo-layout-actions/ dir)` → `src/claxedo-ui/layout-actions.tsx (+ claxedo-ui/layout-actions/ dir)`
  Product-name stutter: everything under src/claxedo-ui/ is already understood to be Claxedo's own layer, so re-prefixing the file with "claxedo-" again adds noise, not information. Same fix applies to the sibling src/claxedo-ui/claxedo-layout-commands.ts.
- `src/claxedo-ui/claxedo-layout.css` → `src/claxedo-ui/root.css (or app-shell.css)`
  Currently one character away from colliding in meaning with the sibling src/claxedo-ui/layout/ directory (the pane-layout engine) even though this file is actually global chrome CSS, not engine styling — the stutter fix alone ("layout.css") would still be confusable with that directory.
- `src/claxedo-ui/layouts/ (42 files)` → `src/claxedo-ui/rail/ (or src/claxedo-ui/workbench-shell/)`
  Differs from the sibling src/claxedo-ui/layout/ (32 files, the generic pane-layout construct/validate/selectors engine) by a single letter, but the two hold unrelated concepts — layouts/ is almost entirely rail-*.tsx/ts files (rail-sidebar, rail-workbench-*, rail-keyboard-*) implementing the Rail/Workbench chrome. "layout" vs "layouts" is a near-guaranteed typo/tab-complete trap for first-time contributors and is not discoverable from the names alone.

## Test location
- Test-runner identity (bun test vs vitest) is encoded only in undocumented filename suffixes, not in directory or any written taxonomy, and the suffix vocabulary itself has sprawled: .test.ts, .vitest.tsx, .integration.vitest.tsx, .ui.vitest.tsx, .bugs.vitest.tsx, .browser.test.ts, .live-resource.test.ts, .cwd-invariant.test.ts, .reactivity.test.ts all coexist across context/, terminal/, claxedo-ui/, session-client/, cloud/, components/.
  Files: src/context/sync.streaming.integration.test.ts, src/claxedo-ui/compact-switcher/CompactSwitcher.bugs.vitest.tsx, src/components/dialog-provider-stack.vitest.tsx, src/components/network-policy-settings.ui.vitest.tsx, src/cloud/runtime/agent-event-runtime.browser.test.ts, src/context/terminal-zombie.test.ts
  Proposal: Document the suffix taxonomy once (which suffix means bun vs vitest, and what the qualifier segment like .bugs/.ui/.integration/.reactivity signals) in AGENTS.md or CONTRIBUTING.md; this is a documentation fix, not a file-move — the colocation itself (test next to subject) is correct and should stay.
- e2e test placement mixes three schemes with only file extension distinguishing the runner: e2e/playwright/*.spec.ts (Playwright) sits in the same directory as e2e/playwright/*.test.ts (actually bun-run, per package.json's test:e2e:bun script), a second dedicated e2e/bun/*.test.ts directory also exists, and three Playwright specs (restoration-e2e-1/2/3) sit flat at e2e/ root outside both subdirs.
  Files: e2e/playwright/real-provider-preflight.test.ts, e2e/restoration-e2e-1-local-workspace.spec.ts, e2e/restoration-e2e-2-cloud-vm.spec.ts, e2e/restoration-e2e-3-plugin-propagation.spec.ts
  Proposal: Move e2e/playwright/real-provider-preflight.test.ts into e2e/bun/ (it is bun-run despite living in the playwright directory), and move the three root-level restoration-e2e-*.spec.ts into e2e/playwright/ so that directory alone (not just extension) tells a contributor which runner a given test needs.

## Proposed tree

```
src/
├─ app.tsx, main.tsx, index.tsx, index.css, env.d.ts, desktop-menu.ts   (entry files, unchanged)
├─ components/                  # + dialogs/, settings/, titlebar/ subdirs (was flat)
│   ├─ dialogs/  settings/  titlebar/  prompt-input/  server/  session/
├─ context/                     # gains: claxedo-events.tsx (from providers/), use-providers.ts (from hooks/)
├─ shell/                       # gains: data/workspace-runtime-store.ts (from cloud/runtime/)
│   ├─ auth/ chat/ chrome/ contributions/ data/ durability/ harnesses/ identity/ layout/ session/ state/ workspace/
├─ claxedo-ui/                  # layout-actions.tsx (destuttered), layout/ (engine), rail/ (renamed from layouts/)
│   ├─ layout-actions/ layout/ rail/ compact-switcher/ components/ content-renderers/ context/
│   ├─ navigation-islands/ state/ terminal/ utils/ workspace-panel/
│   └─ state/pane-preferences.ts   (moved in from pane/)
├─ session/                      # store/, submit/  (charter TBD vs session-client/shell-session/shell-chat — doc, not moved here)
├─ session-client/                composer/ commands/ harness/
├─ terminal/                      backend/ link-parsing/ link-providers/ + core modules
├─ pages/                         + dialog-matrix-harness.tsx (moved in from e2e/)
├─ utils/                         # gains analytics.ts, file-picker.ts, lru-map.ts (from analytics/, constants/, vite-shims/)
│                                 # loses local-selection-handoff.ts (deleted, dead dupe)
├─ shared/  runtime/  browser/  process/  extensions/  i18n/  demo/  architecture/  assets/
└─ (removed) overrides/  providers/  pane/  cloud/  analytics/  constants/  hooks/  vite-shims/  e2e/

Net: 28 → 20 top-level dirs from the merges above (analytics, constants, hooks, vite-shims, providers,
pane, cloud, overrides, e2e all absorbed or deleted). Reaching the aspirational ≤15 requires the higher-risk,
higher-payoff move already flagged by the companion quality audit (P2): consolidating the four session
homes (session/, session-client/, shell/session/, shell/chat/) behind one charter — not attempted here
given import-churn cost and because that doc already owns the direction for it.
```


# claxedo-ui-org

**Verdict:** The tree is functionally well-factored (clear role separation for content-renderers/ vs navigation-islands/, a genuinely public barrel in layout/index.ts, consistent kebab-case almost everywhere) but has accumulated several accidental collisions that will cost a first-time contributor real time: layout/ vs layouts/ (engine vs UI chrome, one letter apart, alphabetically adjacent), claxedo-layout-actions.tsx sitting next to a directory of the identical name, and a context/ directory where 27 of 31 files have nothing to do with SolidJS Context (they're the harness state subsystem mislabeled). components/ is the biggest offender: 64 flat files quietly contain two full features (a 20-file page-editor and a 15-file review-workspace, the latter undercounted by the earlier audit once claxedo-session-review.tsx is correctly attributed to it) plus a dialogs family split inconsistently between a barrel-that-isn't and standalone files. Two directories (workspace-panel/, compact-switcher/) break the repo-wide kebab-case convention with PascalCase component filenames, and state/process-pane.ts vs context/process-pane.tsx is a same-name, different-thing trap. None of these require touching more than a handful of external import sites (verified via grep, typically 3-6 files each), so the fixes are cheap relative to the navigability they buy. No case was found for adding a claxedo-ui root barrel: the directory is a loose federation of independent feature areas (workbench engine, rail chrome, harness state, page editor, review workspace, terminal glue) each already reached into directly by name, not one cohesive public API surface, so a forced index.ts would be ceremony rather than a real fix.

## Misplaced
- **[high]** `claxedo-ui/context/harness-*.ts (21 impl + test files, i.e. everything in context/ except pane-id.tsx, process-pane.tsx, session-params.tsx, session-sync.tsx, process-ownership.ts)` → `claxedo-ui/harness/ (new top-level dir), leaving claxedo-ui/context/ with only its 5 actual SolidJS-context files`
  Verified by grep: only 4 of the 31 files in context/ call createContext/createSimpleContext at all. The other 27 are plain store/reducer/query-cache/status-action logic for the 'harness' (agent runtime) subsystem with zero relation to Solid's Context API. A directory literally named 'context' holding mostly non-context logic actively misleads a contributor looking for where Provider/useX wiring lives.
- **[medium]** `claxedo-ui/claxedo-layout-commands.ts (11 lines, single createProcessPaneToggleCommand factory)` → `claxedo-ui/layouts/ (or claxedo-ui/rail/ per the layouts split above), next to layouts/rail-keyboard-commands.ts`
  This is the same kind of artifact (a CommandOption factory for the app shell) as layouts/rail-keyboard-commands.ts, just stranded alone at the package root instead of living with its sibling. It is consumed by shell/app-shell-commands.ts and tested from layouts/rail-keyboard-commands.test.ts, confirming it conceptually belongs with the rail/workbench command set, not floating at claxedo-ui's top level.
- **[medium]** `claxedo-ui/session-title-sync.ts(+.test.ts) and claxedo-ui/workspace-scope-ids.ts(+.test.ts)` → `claxedo-ui/utils/`
  Both are pure-function-plus-colocated-test modules with no JSX and no Solid reactivity -- exactly the shape of every file already in claxedo-ui/utils/ (active-workspace.ts, workspace-display.ts, etc). Leaving them at the package root next to actual feature directories forces a contributor to treat them as top-level concepts when they are ordinary helpers.
- **[medium]** `claxedo-ui/components/claxedo-session-review.tsx(+.vitest.tsx)` → `claxedo-ui/components/review-workspace/ (see promote_to_dir)`
  Confirmed by grep: its only consumer is components/review-tab.tsx. It is the actual diff/review body rendered inside the review tab, i.e. a core member of the review-workspace feature, not a standalone brand component like claxedo-icon.tsx/claxedo-logo.tsx (which it sits next to only because of the shared 'claxedo-' prefix).

## Promote to directory
- **[high]** `claxedo-ui/components/ (page-editor slice: page-arena-dock.tsx, page-editor-ai.ts, page-editor-chrome.tsx, page-editor-dock.tsx, page-editor-geometry.ts, page-editor-model.ts/.test.ts, page-editor-overlay.tsx, page-editor-tiptap.ts, page-editor-toc.tsx, page-editor-toolbar.tsx, page-editor.tsx, page-index.tsx/.test.ts/.vitest.tsx, tab-page.tsx/.css/.integration.vitest.tsx, tab-page-utils.ts/.test.ts, tab-page-state-flow.test.ts, slash-commands.tsx/.test.ts, status-editor-dialog.tsx, status-editor.test.ts, mermaid-block.ts -- 20 files, verified via imports that slash-commands/mermaid-block/status-editor-dialog are all consumed only by page-editor.tsx/page-index.tsx)` → components/page-editor/{page-editor.tsx, page-editor-chrome.tsx, page-editor-dock.tsx, page-editor-geometry.ts, page-editor-model.ts, page-editor-model.test.ts, page-editor-overlay.tsx, page-editor-tiptap.ts, page-editor-toc.tsx, page-editor-toolbar.tsx, page-editor-ai.ts, page-arena-dock.tsx, page-index.tsx, page-index.test.ts, page-index.vitest.tsx, tab-page.tsx, tab-page.css, tab-page-utils.ts, tab-page-utils.test.ts, tab-page-state-flow.test.ts, tab-page.integration.vitest.tsx, slash-commands.tsx, slash-commands.test.ts, status-editor-dialog.tsx, status-editor.test.ts, mermaid-block.ts}
  This is ~30% of the entire components/ directory (20 of 64 files) all serving one feature (the Tiptap-based page editor + its index/status/slash-command extensions), currently indistinguishable at a glance from unrelated dialogs and review files just because they share the flat directory.
- **[high]** `claxedo-ui/components/ (review-workspace slice: review-loading-state.ts/.test.ts, review-open-diffs.ts/.test.ts, review-tab-header-slot.ts, review-tab.tsx, review-toolbar-slot.ts, review-toolbar.tsx, review-vcs-cache.ts/.test.ts, review-workspace-active-tab.ts/.test.ts, review-workspace-tabs.ts/.test.ts, review-workspace.tsx, claxedo-session-review.tsx/.vitest.tsx -- 15 files)` → components/review-workspace/{review-workspace.tsx, review-workspace-active-tab.ts, review-workspace-active-tab.test.ts, review-workspace-tabs.ts, review-workspace-tabs.test.ts, review-tab.tsx, review-tab-header-slot.ts, review-toolbar.tsx, review-toolbar-slot.ts, review-loading-state.ts, review-loading-state.test.ts, review-open-diffs.ts, review-open-diffs.test.ts, review-vcs-cache.ts, review-vcs-cache.test.ts, review-session.tsx (renamed from claxedo-session-review.tsx), review-session.vitest.tsx}
  This is the exact feature the quality audit flagged (~8 review-* files, undercounted -- there are actually 15 once claxedo-session-review is folded in). All 15 files already share the 'review' vocabulary; grouping them turns 'find the review tab bug' from a directory-wide scan into an obvious single folder.
- **[medium]** `claxedo-ui/components/ (dialog slice: dialogs.tsx [3 inline dialogs: DialogDeleteSession, DialogRecoverWorkspace, DialogDeleteWorkspace, plus a re-export of DialogEditProject], dialog-edit-project.tsx, dialog-process-diagnostics.tsx, add-process-dialog.tsx, status-editor-dialog.tsx -- status-editor-dialog stays with page-editor/ per above, so effectively 4 files + dialogs.tsx)` → components/dialogs/{delete-session-dialog.tsx, recover-workspace-dialog.tsx, delete-workspace-dialog.tsx, edit-project-dialog.tsx, process-diagnostics-dialog.tsx, add-process-dialog.tsx}
  dialogs.tsx is a barrel-that-isn't: it re-exports one dialog (DialogEditProject) from a sibling file while defining three more inline, so the same kind of object (a confirmation dialog) is split three inconsistent ways in one flat directory. Splitting dialogs.tsx into one file per dialog (matching the already-established add-process-dialog.tsx / status-editor-dialog.tsx pattern) removes the barrel-vs-inline inconsistency entirely.

## Flatten / merge
- **[high]** `claxedo-ui/layout/ (engine) and claxedo-ui/layouts/ (rail + workspace-panel UI chrome)`: Rename claxedo-ui/layout/ -> claxedo-ui/workbench/ (its own file is workbench.tsx, exports WorkbenchState/useWorkbench/constructWorkbenchState -- the name is already latent in the code). Then split claxedo-ui/layouts/ along its two real prefixes: the 25 rail-*.ts(x) files -> claxedo-ui/rail/, and the ~10 workspace-panel-*.ts(x)/workspace-tool*/workspace-toolbar* files -> merged into the existing claxedo-ui/workspace-panel/ directory (which already owns this exact concept).
  layout/ vs layouts/ is a one-character, alphabetically-adjacent name collision between a pure state engine and a UI chrome directory -- the single worst 'find the owner in under a minute' failure in this tree. Splitting layouts/ also kills an accidental duplicate home for workspace-panel logic.
- **[high]** `claxedo-ui/claxedo-layout-actions.tsx (file) + claxedo-ui/claxedo-layout-actions/ (directory, 15 files)`: Move the file's contents into claxedo-layout-actions/index.ts and drop the loose file. While touching it, drop the redundant 'claxedo-' prefix (already inside claxedo-ui) -> rename directory to layout-actions/.
  A file and a directory sharing an identical name is a literal collision, not just a naming echo -- an editor's fuzzy-file-search or a case-insensitive filesystem makes this outright ambiguous. This is worse than the layout/layouts case because the names are exactly equal, not just similar.
- **[low]** `claxedo-ui/state/tests/ (metadata.test.ts, orchestration.test.ts, persistence.test.ts)`: Move these 3 files up into state/ alongside their subjects (metadata.ts, orchestration.ts, persistence.ts) and delete the now-empty tests/ subdir.
  state/ colocates 25 of its 28 test files directly next to their subject (e.g. agent-status-listener.test.ts next to agent-status-listener.ts); only these 3 are quarantined in a central tests/ folder for no apparent reason, breaking the directory's own established convention.

## File naming
- `workspace-panel/WorkspacePanel.tsx, ProcessPanePanel.tsx, WorkspaceBrowserPanel.tsx, WorkspaceFilesNavigator.tsx, WorkspaceProcessesNavigator.tsx` → `workspace-panel.tsx, process-pane-panel.tsx, workspace-browser-panel.tsx, workspace-files-navigator.tsx, workspace-processes-navigator.tsx`
  Every other component in claxedo-ui (page-editor.tsx, review-tab.tsx, tab-page.tsx, rail-sidebar.tsx, workbench.tsx) is kebab-case even for the primary default-export component. This directory is one of only two exceptions (see compact-switcher), which reads as an accidental copy-paste from a different codebase convention rather than an intentional signal.
- `compact-switcher/CompactSwitcher.tsx, CompactSwitcher.vitest.tsx, CompactSwitcher.bugs.vitest.tsx` → `compact-switcher.tsx, compact-switcher.vitest.tsx, compact-switcher.bugs.vitest.tsx`
  Same PascalCase-in-a-kebab-repo inconsistency as workspace-panel/; the directory's own sibling files (surface-status.ts, switcher-items.ts) are already kebab-case.
- `state/process-pane.ts (reducer slice: crash flag + pending tab-bar action) vs context/process-pane.tsx (SolidJS createSimpleContext provider)` → `state/process-pane.ts -> state/process-pane-slice.ts`
  Two files with the identical basename in sibling top-level dirs, doing genuinely different things (a plain state-store slice vs an actual Context/provider). A contributor grepping "process-pane" or opening both tabs side by side has no way to tell them apart from the name alone.
- `components/dialog-edit-project.tsx, components/dialog-process-diagnostics.tsx (prefix) vs components/add-process-dialog.tsx, components/status-editor-dialog.tsx (suffix)` → `components/edit-project-dialog.tsx, components/process-diagnostics-dialog.tsx`
  Two different naming conventions for the same concept (a dialog) inside one flat directory; standardizing on the suffix form (already used by half the dialogs) also groups them alphabetically as a family.
- `claxedo-ui/styles.css (57 lines, only touches `.pane-ctrl-icon`)` → `claxedo-ui/pane-controls.css`
  "styles.css" reads as the app's global stylesheet; it is actually a narrow icon-size override for pane floating controls. The generic name is misleading about scope and size.

## Test location
- state/tests/ holds 3 test files (metadata.test.ts, orchestration.test.ts, persistence.test.ts) whose subjects (state/metadata.ts, state/orchestration.ts, state/persistence.ts) sit flat in state/ with no colocated test -- while the other 25 test files in state/ ARE colocated next to their subject (e.g. agent-status-listener.test.ts, route-intent.test.ts).
  Files: claxedo-ui/state/tests/metadata.test.ts, claxedo-ui/state/tests/orchestration.test.ts, claxedo-ui/state/tests/persistence.test.ts
  Proposal: Move all 3 up into state/ as colocated tests and delete state/tests/. (Contrast with claxedo-ui/layout/tests/ which centralizes ALL of layout's tests with zero colocated exceptions -- that one is an intentional, consistent convention for a lettered scenario battery (A-hydration.test.ts .. N-reactivity.vitest.tsx) and should be left alone.)
- components/tab-page-state-flow.test.ts and components/status-editor.test.ts do not name-match their primary subject file 1:1 (tab-page.tsx / status-editor-dialog.tsx) -- acceptable under this repo's qualified-suffix convention (.logic., .bugs., .integration.) but worth confirming intent once these files move into the page-editor/ feature folder, so a reader still finds them by proximity even though the name is a partial match.
  Files: claxedo-ui/components/tab-page-state-flow.test.ts, claxedo-ui/components/status-editor.test.ts
  Proposal: No rename required if moved into components/page-editor/ per the promote_to_dir proposal -- directory proximity resolves the ambiguity; flagging only so the future page-editor/ folder doesn't silently drop these two during the move.

## Proposed tree

```
claxedo-ui/
  workbench/                     (renamed from layout/: pure reducer engine)
    construct.ts, drag-drop.ts, keyboard.ts, provider.tsx, selectors.ts,
    types.ts, validate.ts, workbench.tsx, index.ts, reducers/, tests/
  rail/                          (renamed/split from layouts/: sidebar+canvas chrome)
    rail-sidebar.tsx, rail-sidebar-shell.tsx, rail-workbench-canvas.tsx,
    rail-keyboard-commands.ts, rail-keyboard-controller.tsx, ... (rail-* files)
  workspace-panel/                (absorbs layouts/ workspace-panel-* files; PascalCase -> kebab)
    workspace-panel.tsx, process-pane-panel.tsx, workspace-browser-panel.tsx,
    workspace-files-navigator.tsx, workspace-processes-navigator.tsx,
    workspace-panel-motion-state.ts, workspace-panel-visual-state.ts,
    workspace-panel-body.tsx, workspace-surface-gates.ts, workspace-toolbar.tsx,
    workspace-panel-state.ts, review-intent.ts, process-pane-command.ts (renamed from root claxedo-layout-commands.ts)
  layout-actions/                 (renamed from claxedo-layout-actions/, absorbs the root .tsx file as index.ts)
    index.ts, project-actions.tsx, session-actions.tsx, workspace-actions.ts,
    terminal-actions.ts, page-actions.ts, open-surface-actions-ui.ts, shared.ts, workspace-recovery.tsx
  harness/                        (new: everything pulled out of context/ that isn't a Solid Context)
    harness-store.ts, harness-config-*.ts, harness-hydrator.ts, harness-model-writer.ts,
    harness-options-loader.ts, harness-preferences.ts, harness-prepared-runtime-session.ts,
    harness-query-cache.ts, harness-runtime-session-actions.ts, harness-status-actions.ts, harness-switcher.ts
  context/                        (trimmed: only actual createContext/createSimpleContext files)
    pane-id.tsx, process-pane.tsx, process-ownership.ts, session-params.tsx, session-sync.tsx
  state/                          (tests/ flattened away)
    index.ts, types.ts, provider.tsx, metadata.ts, orchestration.ts, persistence.ts,
    process-pane-slice.ts (renamed), route-*.ts(x), workspace.ts, workspace-panel.ts, ...
  components/
    page-editor/                  (new: 20 files, see promote_to_dir)
    review-workspace/             (new: 15 files incl. renamed review-session.tsx, see promote_to_dir)
    dialogs/                      (new: 6 files, one dialog per file, see promote_to_dir)
    agent-harness-selector.tsx, directory-scope.tsx, session-pane-scope.tsx,
    session-status-stage.tsx, workspace-sdk-provider.tsx, browser-toolbar-slot.ts,
    claxedo-icon.tsx, claxedo-icon-button.tsx, claxedo-logo.tsx,
    tab-file.tsx, tab-file-comments.vitest.tsx, retain-mounted-tabs-policy.ts
  content-renderers/              (unchanged - coherent role-based dir)
  navigation-islands/             (unchanged - coherent role-based dir)
  compact-switcher/                (unchanged location; CompactSwitcher.tsx -> compact-switcher.tsx kebab-cased)
  terminal/                        (unchanged - thin but distinct role: low-level pty fit/recovery)
  utils/                           (absorbs root strays)
    active-workspace.ts, workspace-display.ts, workspace-diff-client.ts, text.ts,
    open-markdown-page-tab.ts, terminal-log-summary.ts, terminal-session-preview.ts,
    session-title-sync.ts (moved from root), workspace-scope-ids.ts (moved from root)
  pane-controls.css (renamed from styles.css)
  claxedo-layout.css
```


# components-pages-session-org

**Verdict:** components/ is a flat fork-era library where the three existing subdirs (server/, prompt-input/, session/) already prove the folder pattern works, yet 24 dialog-* files and 15 settings-* files (plus a 4th unlabeled settings cluster, network-policy-settings.*) sit flat at the top level for no reason other than history — a first-time contributor has to scan 124 mixed filenames to find any one dialog or settings screen. pages/ has a mostly-clean route/page boundary (view-state.ts, session-identity.ts, history-window.ts are genuinely page-internal and well-tested), but two files under pages/session/ — session-layout.ts and helpers.ts — are reached into by components/session/session-header.tsx, which is backwards layering (a 'leaf' component depending on 'page-owned' internals) and proves those two files are actually shared session domain logic mislabeled as page-private. session/ and session-client/ each have internally consistent shapes (store+submit vs composer+harness+commands) but disagree on basic conventions: session/submit/ has an explicitly enforced single-entry index.ts barrel while session/store/ (just as widely consumed) has none, and session-client/session-ui.barrel.ts uses a one-off '.barrel.ts' suffix nowhere else in the repo. A handful of concrete misplacements (a route-helper file living under components/dialog-*, a test for a different package's context provider living in components/) and one duplicate filename across unrelated session domains (handoff.ts) round out the real, fixable navigation traps.

## Misplaced
- **[high]** `packages/claxedo-app/src/components/dialog-select-directory-routes.ts` → `packages/claxedo-app/src/utils/ (alongside the existing workspace-control-routes.ts)`
  Contains generic workspace-runtime URL builders (claxedoBootstrapUrl, workspaceRuntimeFilePath, workspaceRuntimeFindFilePath) with no dialog-specific logic. It is imported by context/sdk.tsx, entirely outside components/, which is backwards for a file named and located as if it were private to the select-directory dialog. A contributor looking for route-builder utilities would never check components/dialog-*.
- **[high]** `packages/claxedo-app/src/components/dialog-provider-stack.vitest.tsx` → `packages/ui/src/context/ (next to dialog.tsx, the file it actually tests) or at minimum out of components/ into an integration-tests location`
  This test exercises DialogProvider/useDialog, which are defined in packages/ui/src/context/dialog.tsx — a different package in the monorepo. There is no 'dialog-provider-stack' source file anywhere in components/; the name implies a local sibling component that does not exist, and the test's actual subject lives in a package this scope doesn't even cover.
- **[high]** `packages/claxedo-app/src/pages/session/session-layout.ts` → `packages/claxedo-app/src/session/ (shared session domain, alongside session/store or session/submit) or components/session/`
  Exports useSessionKey, which is consumed both from within pages/session/** and from components/session/session-header.tsx. components/ is the leaf UI library that pages/ composes (per its own architectural intent); a components/ file reaching into pages/session/ internals is backwards layering, and it proves this logic isn't actually page-private.
- **[medium]** `packages/claxedo-app/src/pages/session/helpers.ts` → `same shared location as session-layout.ts above`
  focusTerminalById is currently used only by components/session/session-header.tsx, a components/ file, not by anything in pages/session.tsx itself — so it is misplaced under pages/session/ where it reads as page-internal but is actually components-domain logic.

## Promote to directory
- **[high]** `packages/claxedo-app/src/components/dialog-*.tsx|ts (24 files)` → components/dialogs/{connect-integration,connect-provider,create-cloud-project(+.test),create-cloud-workspace,custom-provider(+form),fork,manage-models,new-project,release-notes,select-directory(+.test),select-file,select-mcp(+.test,+logic),select-model,select-model-unpaid,select-provider,select-server,settings,provider-stack.vitest}.tsx
  components/ already establishes the folder pattern for related clusters (server/, prompt-input/, session/). The dialog- prefix is doing the job a directory should: several dialogs already show the exact 'component + logic + test' triad the task calls out (dialog-select-mcp.tsx/.test.tsx/-logic.ts; dialog-select-directory.tsx/.test.ts/-routes.ts) as flat siblings that should be grouped. Folderizing also lets each file drop the redundant 'dialog-' prefix, matching how prompt-input/ already dropped its own prefix.
- **[high]** `packages/claxedo-app/src/components/settings-*.tsx|ts (15 files) + network-policy-settings.* (4 files)` → components/settings/{account-section,connections(+core+.test),general,keybinds,list,models,providers,sandbox-section(+helpers+.test+.vitest),terminals(+.test),network-policy(+helpers+.test+.ui.vitest)}.tsx
  Same rationale as dialogs/: a 15-file flat prefix cluster with an existing subdir precedent in the same directory. Folding network-policy-settings.* in too resolves a naming inconsistency for free — it is clearly a settings section but is the only one of the 19 settings files missing the 'settings-' prefix; inside settings/ it wouldn't need any prefix at all.
- **[low]** `packages/claxedo-app/src/components/titlebar*.ts|tsx (5 files: titlebar.tsx, titlebar-history.ts, titlebar-project.ts, titlebar-v2-edit-icon.tsx, titlebar-v2-edit-icon.vitest.tsx)` → components/titlebar/{index(or titlebar).tsx,history.ts,project.ts,v2-edit-icon(+.vitest).tsx}
  Same flat-prefix-namespace pattern as dialog-*/settings-*, just smaller — lower priority because only 5 files and 3 external importers, but folderizing keeps the convention uniform across components/.

## Flatten / merge
- **[medium]** `packages/claxedo-app/src/components/server/`: flatten server/server-row.tsx up to components/server-row.tsx and delete the directory
  Single-file directory with a single importer (dialog-select-server.tsx). It sits next to prompt-input/ and session/, which both hold many files, so its existence as a directory implies a cluster that isn't there — misleading relative to its neighbors.

## File naming
- `packages/claxedo-app/src/components/session.ts` → `packages/claxedo-app/src/components/session/index.ts`
  This barrel file sits flat right next to the components/session/ directory it re-exports from — an easy-to-miss collision (session.ts vs session/) for anyone scanning the tree. It's also an incomplete barrel (exports only 4 of ~9 session/ members; cloud-startup-view and claxedo-session-retry are always imported by direct path instead). Moving it inside as index.ts removes the naming collision and matches the barrel convention used elsewhere (pages/index.ts, session/submit/index.ts).
- `packages/claxedo-app/src/session-client/session-ui.barrel.ts` → `packages/claxedo-app/src/session-client/index.ts`
  Every other barrel in this scope (components/index.ts, pages/index.ts, session/submit/index.ts, pages/session/composer/index.ts) uses plain index.ts. The one-off '.barrel.ts' suffix is unexplained and inconsistent, despite this file having 23 importers across the codebase.
- `packages/claxedo-app/src/pages/session/handoff.ts` → `packages/claxedo-app/src/pages/session/prompt-preview-handoff.ts`
  An unrelated file, session/submit/handoff.ts, already exists with the exact same basename but a completely different responsibility (query-cache prompt-preview handoff between panes vs. post-submit target-acquisition side effects). Same filename, same 'session' feature area, different domain — ambiguous for grep/navigation and for anyone reading an import list out of context.
- `packages/claxedo-app/src/components/dialog-select-mcp-logic.ts, settings-connections-core.ts, settings-sandbox-section-helpers.ts, dialog-custom-provider-form.ts, titlebar-history.ts/titlebar-project.ts` → `pick one suffix convention (e.g. always '-logic.ts') for 'pure logic extracted from this UI component'`
  Five different suffixes (-logic, -core, -helpers, -form, and no suffix at all) are used for the identical pattern — a UI component's paired pure-logic module — inside the same directory, giving a new contributor no way to predict a sibling's name from the pattern alone.

## Test location
- Test file's actual subject lives in a different package entirely, not in this scope
  Files: packages/claxedo-app/src/components/dialog-provider-stack.vitest.tsx
  Proposal: Move to packages/ui (where DialogProvider/useDialog are defined) or, if it must stay for app-level integration reasons, rename to something like dialog-context-integration.vitest.tsx so it doesn't imply a local 'dialog-provider-stack' component that doesn't exist.

## Proposed tree

```
components/
  dialogs/                 <- NEW: folds in 24 flat dialog-* files, prefix dropped
    select-directory.tsx / .test.ts   (select-directory-routes.ts MOVED OUT -> utils/)
    select-mcp.tsx / .test.tsx / -logic.ts
    create-cloud-project.tsx / .test.ts
    ... (custom-provider, fork, manage-models, new-project, release-notes, select-file,
         select-model(-unpaid), select-provider, select-server, settings)
  settings/                <- NEW: folds in 15 flat settings-* files + network-policy-settings.*
    account-section.tsx, connections.tsx (+core+.test), general.tsx, keybinds.tsx,
    list.tsx, models.tsx, providers.tsx, sandbox-section.tsx (+helpers+.test+.vitest),
    terminals.tsx (+.test), network-policy.tsx (+helpers+.test+.ui.vitest)  <- renamed in, prefix dropped
  titlebar/                <- NEW (low priority): titlebar.tsx, history.ts, project.ts, v2-edit-icon.tsx(+.vitest)
  server-row.tsx            <- flattened from server/server-row.tsx (dir deleted)
  prompt-input/             <- unchanged, already well-organized
  session/
    index.ts                <- was components/session.ts (collision with dir name fixed), now a complete barrel
    session-header.tsx, session-context-tab.tsx, session-new-view.tsx, session-new-design-view.tsx,
    cloud-startup-view.tsx, claxedo-session-retry.tsx, session-context-{breakdown,format,metrics}.ts
  cloud-auto-switch.tsx, debug-bar.tsx, file-tree.tsx, link.tsx, model-tooltip.tsx,
  status-popover.tsx, terminal.tsx, windows-app-menu.tsx   <- unchanged flat leaves (genuinely singular)

pages/
  index.ts, session.tsx, home.tsx, login.tsx, cli-login.tsx, config.tsx, error.tsx,
  permissions.tsx, directory-layout.tsx (+ -routes.ts)
  session/                  <- page-internal only, after moving out the two shared files below
    composer/               <- unchanged (deep-link-prompt, session-composer-mode/region/state, dock components)
    history-window.ts, session-identity.ts, view-state.ts, message-timeline.tsx (+.data.ts),
    use-session-commands.tsx, use-session-hash-scroll.ts, terminal-label.ts, message-gesture.ts, ...
    (session-layout.ts, helpers.ts MOVED OUT -> shared session/ location, see misplaced[])

session/                    <- shared session-store/submit domain
  store/
    index.ts                <- NEW barrel, matching submit/'s enforced convention (currently absent)
    session-controller.ts, session-store.ts, session-transport.ts, ...
  submit/
    index.ts                <- unchanged, already the enforced single entry point
    resolve.ts, dispatch.ts, send.ts, handoff.ts, pending.ts, ...

session-client/
  index.ts                  <- renamed from session-ui.barrel.ts
  composer/                 <- unchanged
  harness/                  <- unchanged
  commands/                 <- unchanged
```


# shell-context-org

**Verdict:** shell/ is mostly well organized: 4 of 12 subdirs carry an explicit AGENTS.md charter with import-boundary rules, naming is uniformly kebab-case, and several files even self-declare a `// target-layer: X` comment that makes intent legible — but a third of those tags (context/global-sdk-fetch.ts and three files in context/global-sync/) point at shell/data/ while the files still physically live in context/, meaning the shell↔context coupling the task description flagged as a known problem is not just theoretical: shell/data/global-readiness.ts, directory-session-cache.ts, session-inventory.ts, session-list-events.ts and query-options.ts all reach *up* into context/global-sync for a Solid hook, while context/global-sync.tsx and three of its pure (non-Solid) helper files reach back *down* into shell/data — a real two-way dependency that undermines shell/data's own charter ("UI components should not be imported into this layer"). The "layout" word is worse than a two-home problem: it's a four-home problem (shell/layout/ = genuine chrome-grid config, claxedo-ui/layout/ = pane-split engine, claxedo-ui/layouts/ = rail/workbench components, context/layout.tsx = project-tree/avatar/tabs state that has nothing to do with visual layout), and a fifth directory, shell/chrome/, ironically holds unrelated review-arming logic while shell/layout/ is the actual owner of "chrome" vocabulary (chromeGridDefinition, chromeRegionPlacement). context/ itself is a flat ~30-file dir that already proves out a good pattern twice (file.tsx+file/, global-sync.tsx+global-sync/) but leaves the comparably-sized terminal-* cluster un-grouped, and shell/data/'s 45 files rely on prefix convention alone with no subfolders. Three test files are filed under the wrong top-level module or use a subject-mismatched name, which is a fast way to lose a contribution's test coverage during review. None of this reflects on code quality or duplication (covered elsewhere) — it is specifically about a contributor's ability to find a behavior's owner from the tree, and on that axis the "layout"/"chrome" naming collisions and the shell↔context reach-through are the two things worth fixing first.

## Misplaced
- **[high]** `context/global-sdk-fetch.ts` → `shell/data/global-sdk-fetch.ts`
  File itself is tagged `// target-layer: data` and has zero solid-js imports — it only depends on shell/data/transport, shell/identity, and utils. It is pure request-shaping logic that belongs beside its sibling shell/data/transport/* files, not in the Solid context/ tree.
- **[high]** `context/global-sync/bootstrap-orchestrator.ts` → `shell/data/bootstrap-orchestrator.ts`
  Self-tagged `// target-layer: data` at line 1; 453 lines, zero solid-js imports, and already imports 6+ shell/data modules (bootstrap.ts, session-cache-cleanup.ts, session-load.ts, keys.ts, global-sync-types.ts). It is a data-layer file physically stranded in context/global-sync/.
- **[high]** `context/global-sync/event-ingress.ts` → `shell/data/event-ingress.ts`
  Same self-declared `// target-layer: data` tag and same zero-solid-js profile as bootstrap-orchestrator.ts and inventory-source.ts — all three are the same class of misplaced file.
- **[high]** `context/global-sync/inventory-source.ts` → `shell/data/inventory-source.ts`
  673 lines, self-tagged `// target-layer: data`, no solid-js import. Its abstraction level (row mapping, page-source construction, signed-inventory gates) sits directly below shell/data/session-inventory.ts's thin actions facade — the two should be adjacent.
- **[medium]** `context/global-sync/session-filter.ts` → `shell/data/session-filter.ts`
  Pure helper (no solid-js import) consumed exclusively by shell/data/session-inventory.ts; its sibling context/global-sync/session-trim.ts is consumed exclusively by shell/data/session-list-events.ts. Both are untagged but share the exact same profile as the four tagged target-layer:data files above — shell/data/ code reaching one directory up into context/global-sync/ for its own pure dependencies.
- **[medium]** `context/global-sdk-event-fetch.ts` → `shell/data/global-sdk-event-fetch.ts`
  Same shape and purity as context/global-sdk-fetch.ts (which carries the target-layer:data tag) — no solid-js import, only depends on shell/data/transport and shell/identity. Missing the tag looks like an oversight in the same migration rather than an intentional difference.
- **[medium]** `shell/chrome/app-state-snapshot.ts` → `shell/app-state-snapshot.ts (shell root)`
  Its only consumer is the sibling root file shell/app-shell-state.ts. It shares no theme with its current directory-mate review-region-policy.ts (posthog analytics snapshot vs. review-pane arming policy) — the two files only share a directory by accident.

## Promote to directory
- **[medium]** `context/terminal.tsx + context/terminal-shared.ts + context/terminal-title.ts + context/terminal-test-helpers.ts + 5 terminal-*.test.ts/.vitest.tsx files` → context/terminal/{index.tsx (provider), shared.ts, title.ts, test-helpers.ts, *.test.ts, *.vitest.tsx}
  This is ~9 files and 2000+ lines held together only by a filename prefix, while the same directory already uses a real subdirectory for two comparably-sized domains: context/file.tsx+file/ and context/global-sync.tsx+global-sync/. Terminal is the odd one left flat despite fitting the established pattern exactly.
- **[medium]** `shell/data/ (45 files, flat)` → shell/data/{global/ (global-bootstrap, global-readiness, global-event-projector, global-session-identity, global-sync-types, global-sync-sdk-client-cache), directory/ (directory-cache-manager, directory-event-projector, directory-session-cache, session-cache-cleanup), session/ (session-inventory, session-list-events, session-load, session-prefetch, project-inventory), transport/ (already exists), + keys.ts, queries.ts, writers.ts, inventory-writers.ts, query-options.ts, bootstrap.ts at root}
  45 files in one flat directory (already the single largest subdir in shell/) rely on filename prefixes (global-*, directory-*, session-*) as a substitute for real grouping. That works for alphabetical scanning but not for 'find the owner of this behavior in under a minute' — the directory has already partially solved this for transport/ by carving out a real subdir; the same treatment for the other three families would make the charter in shell/data/AGENTS.md legible at a glance instead of requiring a full-file listing.

## Flatten / merge
- **[high]** `shell/chrome/`: Rename to shell/review/ (or similar) after app-state-snapshot.ts moves to shell/ root (see misplaced). Keep only review-region-policy.ts + its test.
  'chrome' is already the established vocabulary for shell/layout/'s grid/region system (chromeGridDefinition, chromeRegionPlacement, layoutConfigFromLiveChromeState in shell/layout/config.ts). A directory literally named shell/chrome/ that instead holds review-diff-pane arming logic and a posthog analytics snapshot actively misleads a contributor searching for where the app's chrome/region system lives — they will find this directory first and it has nothing to do with layout regions.
- **[low]** `shell/state/`: Rename to shell/connection/
  Both current files (connection-placement.ts, stream-sync-lifecycle.ts) are specifically about the live workspace/relay connection and event-stream lifecycle (consumed by providers/claxedo-events.tsx), not generic app state. 'state' is a catch-all name that tells a first-time contributor nothing; low churn since there is exactly one external consumer file to update.

## File naming
- `context/layout.tsx` → `context/project-workspace-state.tsx (or similar)`
  Content is LocalProject/worktree expand-state, avatar colors, per-session open tabs, review-diff-style, and scroll persistence — nothing about visual layout. The name collides with three genuinely distinct 'layout' homes already in the tree: shell/layout/ (chrome grid/region config — chromeGridDefinition, chromeRegionPlacement), claxedo-ui/layout/ (the pane-split/workbench tree engine), and claxedo-ui/layouts/ (rail/workbench UI components). A contributor grepping 'layout' for the project-tree/avatar/tabs logic will not find it here by name, and will instead land in three unrelated modules first.
- `shell/harnesses/profile.test.tsx` → `shell/harnesses/profile.test.ts`
  Uses bun:test with no JSX and no DOM, exactly like every other plain .test.ts file in shell/. The project's own convention reserves the .tsx test suffix for the small set of vitest+jsdom Solid-component tests (context/config.vitest.tsx, shell/auth/*.vitest.tsx, shell/workspace/workspace-gate.vitest.tsx). This file's .tsx extension falsely implies it follows that convention.

## Test location
- Test file sits at context/ root with a name that mimics a subdirectory path, but its imports actually span three different modules (bootstrap-orchestrator.ts, the global-sync index re-export, and event-ingress.ts) — none of which is 'inventory-source', the file whose name it borrows. Meanwhile context/global-sync/inventory-source.ts already has its own correctly-colocated test (context/global-sync/inventory-source.test.ts), so the root-level file's name is actively confusing about which test file covers what.
  Files: context/global-sync-inventory-source.test.ts
  Proposal: Rename/relocate into context/global-sync/ reflecting what it actually integration-tests (e.g. signed-route-bootstrap.test.ts), or fold its cases into bootstrap-orchestrator.ts's/event-ingress.ts's own test files. Remove the confusing root-level near-duplicate name.
- Test exclusively imports and exercises shell/session/open-sessions.ts (clearOpenSessions, hasOpenSession, openSessionRefsFromMetas, setOpenSessions) but is filed under a completely different top-level module, context/global-sync/.
  Files: context/global-sync/open-sessions.test.ts
  Proposal: Move to shell/session/open-sessions.test.ts, colocated with its subject like every other shell/session/*.test.ts file.
- Test file name doesn't match its actual subject: it tests shell/data/session-inventory.ts (loadSessionInventory, reloadSessionInventory, loadMoreSessionInventory*), which otherwise has no dedicated test file of its own, plus a normalizer imported from queries.ts.
  Files: shell/data/global-session-inventory.test.ts
  Proposal: Rename to shell/data/session-inventory.test.ts, matching the name-matches-subject convention used by every other file in shell/data/ (e.g. project-inventory.ts/project-inventory.test.ts, session-load.ts/session-load.test.ts).

## Proposed tree

```
shell/
  app-shell.tsx, app-shell-state.ts, app-shell-layout.tsx, ...   (root composition, unchanged)
  app-state-snapshot.ts                                          <- moved up from chrome/
  auth/            (AGENTS.md ✓)
  chat/
  contributions/
  data/
    global/        <- NEW: global-bootstrap, global-readiness, global-event-projector,
                       global-session-identity, global-sync-types, global-sync-sdk-client-cache
    directory/      <- NEW: directory-cache-manager, directory-event-projector,
                       directory-session-cache, session-cache-cleanup
    session/        <- NEW: session-inventory, session-list-events, session-load,
                       session-prefetch, project-inventory
    transport/      (existing, unchanged)
    bootstrap-orchestrator.ts   <- moved in from context/global-sync/
    event-ingress.ts            <- moved in from context/global-sync/
    inventory-source.ts         <- moved in from context/global-sync/
    session-filter.ts           <- moved in from context/global-sync/
    global-sdk-fetch.ts         <- moved in from context/
    global-sdk-event-fetch.ts   <- moved in from context/
    keys.ts, queries.ts, writers.ts, inventory-writers.ts, query-options.ts, bootstrap.ts
  durability/
  harnesses/       (kept as-is: reserved nucleus for the multi-harness concept)
  identity/        (AGENTS.md ✓)
  layout/          (AGENTS.md ✓ — the ONLY real "chrome grid/region" owner)
  review/          <- RENAMED from chrome/: review-region-policy.ts only
  connection/      <- RENAMED from state/: connection-placement.ts, stream-sync-lifecycle.ts
  session/
  workspace/

context/
  terminal/         <- NEW subdir (mirrors file/, global-sync/ pattern):
    index.tsx (was terminal.tsx), shared.ts, title.ts, test-helpers.ts, *.test.ts, *.vitest.tsx
  file.tsx + file/          (unchanged — already the model pattern)
  global-sync.tsx + global-sync/   (slimmed: queue, session-pagination, session-trim,
                                     types, utils, global-event-refresh-policy remain;
                                     the 3 pure target-layer:data files move to shell/data/)
  global-sdk.tsx (+ .test.ts only; fetch helpers moved to shell/data/)
  project-workspace-state.tsx   <- RENAMED from layout.tsx
  layout-projects.ts, layout-scroll.ts   <- rename prefix to match (project-*, scroll-*) once layout.tsx renames
  permission.tsx, permission-auto-respond.ts, permission-auto-response-cache.ts
  command.tsx, command-upstream.tsx
  config.tsx, settings.tsx, models.tsx, platform.tsx, language.tsx, notification.tsx,
  highlights.tsx, comments.tsx, prompt.tsx, server.tsx, sdk.tsx, local.tsx  (unchanged, each single-domain)
```


# support-dirs-org

**Verdict:** terminal/ is the healthiest tree in scope: the engine/component/pane-integration three-way split (src/terminal vs components/terminal.tsx vs claxedo-ui/terminal/) is correct and verified (zero solid-js imports in the engine), and link-parsing/ vs link-providers/ are correctly separated layers, not a merge candidate. Its only real placement problem is that the planned helpers.ts split should land inside backend/ (which it's already an undeclared part of) rather than at terminal/ root, plus six large cross-module scenario tests and one stale duplicate test need sorting into a real integration/ subdir. utils/ is the opposite story: a 68-file, ungoverned dumping ground spanning at least five unrelated tiers (pure helpers, TanStack-Query cache accessors, core transport/runtime infra, backend API clients, and session/workspace domain logic used across components AND pages) with a dead barrel and a 3220-line whole-repo audit masquerading as a unit test — the full cluster-to-home map is in proposed_tree. shared/ (query/ + data/) is, by contrast, a real and coherent charter distinct from utils/ once you read the file headers (data = wire shapes + raw transport, query = TanStack wrappers over it) — it just isn't documented and gets diluted by utils/'s violations. Of the eleven small dirs, most are fine as-is (browser, runtime, process, providers, extensions, demo, architecture, i18n are all coherently single-purpose); the two worth acting on are cloud/ (its runtime/ subdir is redundant AND name-collides with the unrelated top-level runtime/ dir) and pane/ (a single-file dir wrapping a single-file dir). i18n/ specifically is already pure data with zero logic files inside it — the "logic mixed" concern in the prompt is actually about context/language.tsx (outside this scope), not this directory.

## Misplaced
- **[high]** `packages/claxedo-app/src/utils/workspace-runtime-route-audit.test.ts` → `packages/claxedo-app/src/architecture/ (as a scanner script, or split into scanners.ts-style checks)`
  3220-line whole-repo import-boundary audit pinned to ~40 hardcoded paths across session/shell/claxedo-ui/components/context/pages — tests nothing in utils/ itself. architecture/ already exists specifically to house this kind of boundary/guard check (import-graph.ts, scanners.ts, *.guard.test.ts); leaving it in utils/ hides the app's most repo-wide-reaching test inside the directory this review is trying to shrink.
- **[high]** `packages/claxedo-app/src/cloud/runtime/agent-event-runtime.browser.test.ts` → `packages/claxedo-app/src/architecture/ (alongside library-drift.guard.test.ts) or colocated with context/global-sdk.tsx, its only production consumer`
  This test imports and smoke-tests @claxedo/agent-event-runtime (a different top-level package) in a browser-like environment — it has zero relation to anything else in cloud/runtime/ (workspace-runtime-store.ts, a cloud-sandbox-provisioning state store). Its only production consumer anywhere in claxedo-app is context/global-sdk.tsx. A contributor opening cloud/runtime/ to understand cloud workspace provisioning will trip over an unrelated cross-package bundling smoke test.
- **[high]** `packages/claxedo-app/src/utils/workspace-relay-connection.ts` → `packages/claxedo-app/src/runtime/`
  387 lines of JWT decoding, circuit-breaker cooldowns, retry/backoff, and connection caching — this is core session-connectivity infrastructure, not a generic utility. src/runtime/ already exists and owns exactly this tier (agent-runtime-client.ts, signed-workspace.ts); moving it there (with its .test.ts) gives it a home that matches its actual responsibility instead of hiding load-bearing transport code in a 68-file grab bag.
- **[high]** `packages/claxedo-app/src/utils/workspace-runtime-request.ts` → `packages/claxedo-app/src/runtime/`
  255 lines of transport routing / relay path rewriting (resolveRuntimeTarget etc.) — same tier and same fix as workspace-relay-connection.ts above; the two should move together into runtime/ since they're the two halves of the same 'how do we reach a workspace's runtime' concern.
- **[medium]** `packages/claxedo-app/src/utils/workspace-control-routes.ts` → `packages/claxedo-app/src/runtime/`
  Pure route-path builders for the workspace control plane, consumed by runtime/agent-runtime-client.ts, shared/query/session-list.ts, shared/data/http-backend.ts, and a dozen components/pages call sites. It's the third leg of the workspace-transport trio (with workspace-relay-connection.ts and workspace-runtime-request.ts) and belongs alongside them rather than filed as a generic util.
- **[high]** `packages/claxedo-app/src/utils/directory-config-cache.ts` → `packages/claxedo-app/src/shared/query/ (with directory-search-cache.ts and file-request-cache.ts)`
  All three directly call queryClient.getQueryData/setQueryData exactly like shared/query/*.ts does — they are TanStack-Query cache accessors wearing a utils/ label, with no principled line separating them from shared/query today. Moving the cluster there gives 'is this a cache accessor?' one unambiguous home.
- **[medium]** `packages/claxedo-app/src/utils/api.ts` → `packages/claxedo-app/src/shared/data/`
  The base HTTP client (authFetch, normalizeUrl, demo-mode helpers) that shared/data/http-backend.ts already imports and that is itself commented as 'the shared URL normalizer used by every Claxedo URL builder' — it is the transport primitive shared/data/ is built on, not a peer of array.ts/uuid.ts. Co-locating it with http-backend.ts also makes the existing normalizeUrl-duplication problem (5 reimplementations) easier to see and fix, since importer and canonical source would be one directory apart instead of two.
- **[medium]** `packages/claxedo-app/src/utils/convex-client.ts` → `packages/claxedo-app/src/shared/data/`
  A backend-transport client for Convex, the same tier as shared/data/http-backend.ts (both are 'which backend do we talk to and how'). Filing one transport client in shared/data/ and the other in utils/ gives no rule for where the next one goes.
- **[medium]** `packages/claxedo-app/src/utils/prompt.ts` → `packages/claxedo-app/src/shared/data/`
  200-line message-part→prompt reconstruction is session/workspace domain logic, the same tier as shared/data/session-types.ts and session-lifecycle.ts, not a generic helper. It's imported by both components/dialog-fork.tsx and pages/session.tsx, so it can't move into pages/session/ (that would make components/ import from pages/, inverting the app's layering) — shared/data/ is the correct cross-tier home. utils/comment-note.ts and utils/session-title.ts are the same shape and should move alongside it.
- **[medium]** `packages/claxedo-app/src/utils/worktree.ts` → `packages/claxedo-app/src/shared/data/`
  WorktreeState is workspace-lifecycle domain logic (git worktree awareness) consumed across context/, components/, claxedo-ui/, and session/ — too broadly cross-cutting to belong to any one feature directory, and the same tier as shared/data/session-lifecycle.ts. It also independently reimplements utils/same.ts's array-equality check, which becomes easier to notice once it sits next to session-lifecycle.ts's similar helpers instead of buried in utils/.
- **[low]** `packages/claxedo-app/src/utils/terminal-websocket-url.ts` → `packages/claxedo-app/src/terminal/`
  A terminal-domain URL builder (PTY websocket URL construction) stranded in the generic utils/ dumping ground instead of living with the rest of the terminal engine it exclusively serves. Its dead sibling utils/terminal-writer.ts is the same story (also terminal-domain, currently unused — delete rather than move).
- **[low]** `packages/claxedo-app/src/terminal/terminal-backend.d.ts` → `packages/claxedo-app/src/terminal/backend/`
  This ambient .d.ts exists solely to type the '#terminal-backend' subpath import that resolves to backend/xterm.ts (confirmed via architecture/import-graph.ts's own resolver and components/terminal.tsx's `await import("#terminal-backend")`). Sitting flat at terminal/ root, it looks like an unrelated stray type file; it is really backend/'s public type surface and should live inside backend/ next to types.ts and xterm.ts.
- **[medium]** `packages/claxedo-app/src/utils/auth-client.ts` → `packages/claxedo-app/src/shared/data/ (or packages/claxedo-app/src/runtime/)`
  373 lines of cross-account localStorage purge / Clerk identity-change handling is session-identity infrastructure, not a generic helper — same tier as shared/data/session-lifecycle.ts (which account's session data is allowed to persist) and consumed by runtime/agent-runtime-client.ts (getAuthToken). Filing it in utils/ hides a security-relevant module behind a generic name.

## Promote to directory
- **[high]** `packages/claxedo-app/src/terminal/helpers.ts` → packages/claxedo-app/src/terminal/backend/{renderer.ts, terminal-instance.ts, keyboard.ts, clipboard.ts, resize-handlers.ts, xterm.ts, types.ts}
  907-line 'helpers.ts' is entirely the DOM/xterm-instance wiring for the ONE concrete backend implementation, backend/xterm.ts (391 lines) — it already calls createTerminalInstance/setupKeyboardHandler/setupPasteHandler/setupCopyHandler/setupDropHandler/setupResizeHandlers/loadRenderer from helpers.ts. The planned split's pieces belong inside backend/ (which currently holds only types.ts + xterm.ts) rather than staying flat at terminal/ root, where a growing set of renderer/keyboard/clipboard/resize files would otherwise dilute the root's pure-protocol-logic files (mode-scan, query-suppression, terminal-buffer, etc.) with DOM-specific ones. This also fixes keyboard.test.ts's existing './helpers' import, which already anticipates a keyboard.ts module.
- **[medium]** `packages/claxedo-app/src/marketplace/marketplace-panel.tsx` → packages/claxedo-app/src/marketplace/{panel.tsx, <sub-sections split from the 1074-line file>, marketplace.css?}
  marketplace/ already exists as a top-level directory but holds exactly one 1074-line file — the directory shell is right, but the file itself is large enough (and is the sole occupant of its own top-level namespace) that it should actually be decomposed into the directory it nominally is, rather than staying a single-file dir masquerading as a real feature module.
- **[low]** `packages/claxedo-app/src/utils/pages-api.ts` → shared/data/{pages-api.ts, arena-api.ts}
  Splitting the file (see file_naming) also resolves an organization question: once split, pages-api.ts and arena-api.ts can each move to their correct shared/data/ home individually instead of the combined file forcing a single, wrong decision.

## Flatten / merge
- **[medium]** `packages/claxedo-app/src/pane/store/`: flatten pane/store/pane-preferences.ts (+ .test.ts) up to pane/pane-preferences.ts
  pane/ contains nothing but this one store/ subdirectory, which contains nothing but this one file pair. The extra 'store' segment adds no disambiguating information (there is no other pane/ concept it's being distinguished from) — despite the shallow nesting this is a widely-imported, genuinely central module (session-client/composer, claxedo-ui/context/harness-*, session/submit/handoff.ts, components/prompt-input/submit.ts all depend on it), so it deserves to be easy to find at pane/pane-preferences.ts rather than one level deeper for no reason.
- **[high]** `packages/claxedo-app/src/cloud/runtime/`: flatten cloud/runtime/workspace-runtime-store.ts (+.test.ts) up to cloud/workspace-runtime-store.ts; relocate the unrelated agent-event-runtime.browser.test.ts out of this directory entirely (see misplaced)
  cloud/ has no content besides this one runtime/ subfolder, so the nesting buys nothing — and worse, it collides in name with the sibling top-level src/runtime/ directory (agent-runtime-client.ts, session-projection.ts, signed-workspace.ts), which is a *different* concept (agent/session transport vs cloud sandbox provisioning state). A contributor searching 'runtime' in the tree hits two unrelated directories named the same thing at different depths.
- **[low]** `packages/claxedo-app/src/utils/index.ts`: delete
  Zero importers repo-wide (@claxedo/utils bare import has no hits) and only re-exports 6 of 68 modules — as utils/ gets dissolved per WP-D3 this barrel becomes even more actively misleading, implying a curated public surface that never existed.
- **[high]** `packages/claxedo-app/src/utils/ (as a whole)`: dissolve per the cluster table in proposed_tree; keep a slim utils/ for dependency-free primitives only
  68 flat files spanning at least 5 unrelated tiers (pure helpers, TanStack-Query cache accessors, core transport/runtime, API clients, session/workspace domain logic) with no stated rule for what belongs there. This is the central ask of this review — full cluster-to-home mapping is in proposed_tree.

## File naming
- `terminal/terminal-tui.ts` → `terminal/reconnect-heuristics.ts`
  Exports isLikelyTui/filterModeSequences/cursorPlan/restoreSize/initialDelay — reconnect/restore-time heuristics gated on TUI-likelihood, not TUI rendering. The name reads as if it renders/models a TUI, misleading a contributor searching for 'where does the TUI live'.
- `terminal/terminal.connection.test.tsx` → `delete (duplicate of terminal-connection.test.ts)`
  Every other test in the directory is dash-separated *.test.ts; this one file uses dot-separation and a .tsx extension despite containing zero JSX — it also duplicates terminal-connection.test.ts's coverage, so the naming break is a symptom of it being a stale leftover.
- `shared/query/utils.ts` → `shared/query/sort.ts (cmp) + shared/query/provider-list.ts (normalizeProviderList)`
  A file literally named 'utils.ts' one level inside shared/query/, a sibling of the top-level utils/ dir this review is dissolving, is actively confusing to grep for ('utils.ts' matches two unrelated files at two different tree depths with unrelated content). Splitting by the two unrelated exports also removes the drift risk noted where inventory.ts redefines cmp instead of importing this file.
- `utils/pages-api.ts` → `shared/data/pages-api.ts + shared/data/arena-api.ts`
  Filename promises a Pages CRUD client; roughly a third of the file's types/methods (ArenaConfig/arenaStart/arenaState/...) implement an unrelated multi-agent swarm feature with no naming hint. Splitting also lets each file land in its correct shared/data/ home individually.
- `i18n/br.ts` → `i18n/pt-BR.ts`
  ISO 639-1 'br' is Breton; the file's content is Brazilian Portuguese and context/language.tsx's own INTL map resolves it to 'pt-BR'. A contributor skimming the directory listing will misidentify the language from the filename alone.
- `utils/runtime-adapters.ts` → `delete`
  Zero importers repo-wide; the name promises generic 'runtime adapters' but the actual contents are unrelated duck-typing checks (dispose/setOption/hovered-link-text/speech-recognition-ctor) with no unifying theme — the name doesn't even describe what's there, let alone why it'd be worth keeping.
- `providers/ (dir, holds only claxedo-events.tsx + index.ts)` → `events/ or claxedo-events/ (or leave as-is if a second provider is genuinely planned)`
  Plural directory name currently backs exactly one concept (the Claxedo SSE/event bus provider). Fine to leave if more providers are coming; otherwise the plural over-promises breadth the directory doesn't have.

## Test location
- utils/resolve-runtime-target.test.ts tests exactly one export (resolveRuntimeTarget) of a *different* file, utils/workspace-runtime-request.ts, but is named after the function rather than the module — a contributor opening workspace-runtime-request.ts to check its test coverage will not find a workspace-runtime-request.test.ts and may conclude there is none.
  Files: packages/claxedo-app/src/utils/resolve-runtime-target.test.ts, packages/claxedo-app/src/utils/workspace-runtime-request.ts
  Proposal: Rename to workspace-runtime-request.test.ts (merging with any existing test of that module, or simply renaming if none exists) so test-file-name-matches-subject-file holds.
- terminal/terminal.connection.test.tsx is a stale, dot-separated, .tsx-suffixed duplicate that shadows terminal-connection.test.ts — breaks the dash-separated *.test.ts convention every other file in the directory follows, and a contributor editing terminal-connection.ts has no signal a second spec exists to keep in sync.
  Files: packages/claxedo-app/src/terminal/terminal.connection.test.tsx, packages/claxedo-app/src/terminal/terminal-connection.test.ts
  Proposal: Port any unique assertions into terminal-connection.test.ts and delete the .tsx duplicate.
- Six terminal/ test files (headless.test.ts, headless-emulator.test.ts, terminal-lifecycle.test.ts, terminal-paste-duplication.test.ts, terminal-pipeline.test.ts, terminal-focus-switch.test.ts) are large (200-1140 lines each, ~3500 lines total) cross-module integration/scenario specs that instantiate a real @xterm/headless Terminal and exercise several root modules together — none corresponds to a single source file the way the rest of the directory's tests do (mode-scan.test.ts → mode-scan.ts, etc.), so they're easy to mistake for orphaned or misnamed unit tests.
  Files: packages/claxedo-app/src/terminal/headless.test.ts, packages/claxedo-app/src/terminal/headless-emulator.test.ts, packages/claxedo-app/src/terminal/terminal-lifecycle.test.ts, packages/claxedo-app/src/terminal/terminal-paste-duplication.test.ts, packages/claxedo-app/src/terminal/terminal-pipeline.test.ts, packages/claxedo-app/src/terminal/terminal-focus-switch.test.ts
  Proposal: Move these six into a new terminal/integration/ subdirectory (sibling to backend/, link-parsing/, link-providers/) so the root's *.test.ts files reliably mean '1:1 unit spec' and integration/ reliably means 'cross-module scenario coverage'.
- cloud/runtime/agent-event-runtime.browser.test.ts tests an entirely different top-level package (@claxedo/agent-event-runtime) with no source file in cloud/runtime/ to anchor it — covered in detail under misplaced.
  Files: packages/claxedo-app/src/cloud/runtime/agent-event-runtime.browser.test.ts
  Proposal: Move to architecture/ or colocate with context/global-sdk.tsx (see misplaced entry).
- utils/workspace-runtime-route-audit.test.ts is filed as a utils/ unit test but is a ~100-case, 3220-line whole-repo import-boundary audit with no relationship to any single utils/ module — covered in detail under misplaced.
  Files: packages/claxedo-app/src/utils/workspace-runtime-route-audit.test.ts
  Proposal: Relocate to architecture/ as a scanner/lint-style check (see misplaced entry).

## Proposed tree

```
SCOPE 1 — terminal/ (engine) + its satellites in components/ and claxedo-ui/

  The three-way split (src/terminal = framework-free engine; src/components/terminal.tsx = the
  SolidJS component that wires it to the DOM/SDK; src/claxedo-ui/terminal/{terminal-fit.ts,
  pane-terminal-recovery.ts} = pane/dock-layer integration hooks) is CORRECT and should stay.
  Verified: src/terminal has zero solid-js imports; components/terminal.tsx is the only place
  that imports the engine via the `@claxedo/terminal/*` alias and instantiates it in a component;
  claxedo-ui/terminal/'s two files depend on pane/dock concerns (a DOM CustomEvent bus, and an
  ID-aliasing cache keyed through shared/query/query-client) that have nothing to do with xterm
  internals, so keeping them out of the engine is right. The one real problem is INSIDE
  src/terminal: a 907-line "helpers.ts" is entirely backend/xterm.ts's DOM-wiring guts, so the
  planned split should land inside backend/, not at terminal/ root:

  terminal/
    backend/
      types.ts                 (unchanged: TerminalBackend interface)
      xterm.ts                 (unchanged: composition/entry point, now calls the 5 files below)
      terminal-instance.ts      NEW ← helpers.ts: createTerminalInstance
      renderer.ts               NEW ← helpers.ts: loadRenderer / isWebGLSupported
      keyboard.ts               NEW ← helpers.ts: setupKeyboardHandler (keyboard.test.ts already
                                                    imports from "./helpers" expecting this shape)
      clipboard.ts              NEW ← helpers.ts: setupPasteHandler/setupCopyHandler/setupDropHandler
      resize-handlers.ts        NEW ← helpers.ts: setupResizeHandlers
      terminal-backend.d.ts     MOVED from terminal/ root (types the "#terminal-backend" subpath
                                                    import that resolves to backend/xterm.ts)
    link-parsing/               unchanged — correctly separate layer (ported vscode algorithm)
    link-providers/             unchanged — correctly separate layer (ILinkProvider wiring)
    integration/                NEW ← 6 cross-module scenario tests moved out of root:
      headless.test.ts, headless-emulator.test.ts, terminal-lifecycle.test.ts,
      terminal-paste-duplication.test.ts, terminal-pipeline.test.ts, terminal-focus-switch.test.ts
    (root stays exactly the well-factored protocol/pure-logic modules it already is:
     capability-responder, config, input-reply-filter, mode-scan, query-suppression,
     resize-coordinator(+resize-drag-suspension/resize-on-split), terminal-buffer,
     terminal-connection, terminal-geometry, terminal-recovery, terminal-runtime-queue,
     terminal-stream, terminal-tui→reconnect-heuristics, retry, terminal.css)
    ✗ delete terminal.connection.test.tsx (stale duplicate of terminal-connection.test.ts)

SCOPE 2 — utils/ dissolution (WP-D3 target map; 68 files → 5 real homes + a slim residual utils/)

  cluster                                          → target home                    | files (representative)
  ------------------------------------------------ | ------------------------------ | -----------------------
  dependency-free primitives (STAYS in utils/)     | utils/                          | array, base64, binary, encode, id, iife, path, path-key, same, time, url(+.test), uuid, retry, debug, scoped-cache, sound(+.test), fetch-throttle(+.test), notification-click, agent.ts
  TanStack-Query cache accessors                   | shared/query/                  | directory-config-cache, directory-search-cache, file-request-cache (agent-cache/project-meta-cache: delete, dead+duplicate)
  core transport/runtime infra                     | runtime/ (existing dir)        | workspace-relay-connection(+.test), workspace-runtime-request(+.test, incl. resolve-runtime-target.test.ts renamed), workspace-control-routes(+.test) (runtime-adapters.ts: delete, dead)
  backend/service transport clients                | shared/data/                   | api(+.test), convex-client(+.test), credential-request(+.test), server.ts, server-health(+.test), share-workspace(+.test), auth-client.ts
  session/workspace domain logic                   | shared/data/                   | prompt.ts, comment-note.ts, session-title.ts, session-url(+.test), worktree(+.test)
  API product clients                              | shared/data/                   | pages-api(+.test) split → pages-api.ts + arena-api.ts; living-apps-api(+.test)
  whole-repo import-boundary audit                 | architecture/                  | workspace-runtime-route-audit.test.ts (as a scanner, not a utils/ unit test)
  dead files                                        | delete                         | index.ts (barrel), agent-cache.ts, aim.ts, runtime-adapters.ts, terminal-writer.ts, local-selection-handoff.ts, project-meta-cache.ts

  Net effect: utils/ shrinks from 68 files to ~25 genuinely dependency-free helpers; every other
  file gets one unambiguous home instead of "wherever it happened to land."

SCOPE 3 — shared/

  shared/data/ ("what does the backend send us, and how do we reach it": types.ts, session-types,
  session-lifecycle, http-backend) and shared/query/ ("TanStack Query wrappers built on top of
  shared/data's shapes": keys, runtime, session-list, control-plane, directory, shell, inventory,
  persister, query-client) is a REAL, coherent, distinct charter from utils/ — confirmed by reading
  headers: shared/data files define wire-shape types and raw transport; shared/query files layer
  queryOptions/cache-key logic on top. The charter just isn't written down anywhere and utils/
  currently violates its boundary wholesale (see Scope 2). Only internal nit: shared/query/utils.ts
  → split into shared/query/sort.ts (cmp) + shared/query/provider-list.ts (normalizeProviderList) —
  a file named "utils.ts" one level inside the very dir this review is trying to disambiguate from
  utils/ is an unforced naming collision.

SCOPE 4 — support dirs (one verdict each, scope="support-dirs-org")

  browser/            KEEP AS-IS — coherent components/+store/ feature dir, both subdirs earn their
                       keep (multiple files each), matches the rest of the app's Solid conventions.
  runtime/             KEEP AS-IS, becomes the destination for the utils/ transport cluster above —
                       already the right charter (agent-runtime-client, session-projection, signed-workspace).
  cloud/               FLATTEN — cloud/runtime/ has no sibling content to justify nesting, and its name
                       collides with the unrelated top-level runtime/. Flatten to cloud/workspace-runtime-store.ts;
                       relocate the misplaced agent-event-runtime.browser.test.ts out entirely (see misplaced).
  process/             KEEP AS-IS — 4 files, one coherent domain (background process client + model), fine flat.
  providers/           KEEP AS-IS (low-priority rename candidate) — plural name for a single provider
                       (claxedo-events); fine if more providers are planned, otherwise rename to events/.
  pane/                FLATTEN — pane/store/ is a single-file subdirectory of a single-file top-level dir;
                       merge to pane/pane-preferences.ts (module itself is widely used and stays put).
  extensions/           KEEP AS-IS — 5 files, one well-documented concept (the app-shell extension-point
                       system, successor to @opencode-ai/app-shared); no changes needed.
  marketplace/         PROMOTE (internally) — directory shell already exists but holds one 1074-line
                       file; should be decomposed into the multi-file directory its size implies.
  demo/                KEEP AS-IS — 4 files, one coherent concept (demo-mode fixtures/handlers/tour).
  architecture/         KEEP AS-IS, becomes destination for 2 misplaced tests (workspace-runtime-route-audit.test.ts,
                       agent-event-runtime.browser.test.ts) — already the house style for boundary/guard checks.
  i18n/                KEEP AS-IS structurally — confirmed by reading every file: this directory is
                       ALREADY pure data (17 flat locale dicts + cloud-strings.ts, itself data). There is
                       no logic file inside i18n/ today to separate out. The registry "logic" the prompt
                       is sensing (Locale type, LOCALES, INTL, loaders, matchers) correctly lives outside
                       this directory in context/language.tsx — that it's grown into 5 hand-synced
                       structures there is a content problem (already flagged in the companion quality
                       audit), not a placement problem for i18n/ itself. Only naming nit: br.ts → pt-BR.ts
                       (see file_naming).
```


# test-placement

**Verdict:** The de-facto convention (colocated <subject>.test.ts / <subject>.vitest.tsx siblings) holds for roughly 94% of the ~300 test files and is genuinely good — a contributor can `ls` any directory and see subject+test pairs. The violations are concentrated and each breaks a different guarantee: (1) two undocumented `tests/` subfolders (layout/tests with opaque A-N letters, state/tests with only 3 of 17 siblings pulled out) that a contributor cannot discover without already knowing they exist; (2) three test files whose docstrings/imports/filenames cite a `rail-layout.tsx` that no longer exists in the tree, actively misdirecting anyone trying to find the real owner (rail-sidebar.tsx / app-shell-layout.tsx); (3) two `.test.ts` files that import from `vitest` instead of `bun:test`, silently breaking the one naming rule (extension signals runner) that is otherwise 291/293 consistent; (4) root `e2e/` has 3 loose `*.spec.ts` files sitting outside the `e2e/playwright/` directory that holds the other 28, plus one `.test.ts` (bun-run) file living inside `e2e/playwright/` where the directory name implies playwright-only. None of this is unfixable — it is a handful of renames/moves, not a redesign — but every one of these is a case where grep/glob-based navigation gives a first-time contributor a wrong or dead answer.

## Misplaced
- **[medium]** `e2e/restoration-e2e-1-local-workspace.spec.ts` → `e2e/playwright/restoration-e2e-1-local-workspace.spec.ts`
  Same runner/suffix (*.spec.ts, playwright testMatch picks it up regardless of subfolder) and same purpose as the 28 other files that all live in e2e/playwright/; sitting at e2e/ root makes it invisible when a contributor lists 'the e2e suite' via e2e/playwright/*.
- **[medium]** `e2e/restoration-e2e-2-cloud-vm.spec.ts` → `e2e/playwright/restoration-e2e-2-cloud-vm.spec.ts`
  Same as restoration-e2e-1: only 3 of 31 total .spec.ts files are outside e2e/playwright/, with no naming or purpose distinction that explains the split.
- **[medium]** `e2e/restoration-e2e-3-plugin-propagation.spec.ts` → `e2e/playwright/restoration-e2e-3-plugin-propagation.spec.ts`
  Same as above.
- **[medium]** `e2e/playwright/real-provider-preflight.test.ts` → `e2e/bun/real-provider-preflight.test.ts (or a neutral e2e/unit/)`
  Directory is named 'playwright' and playwright's testMatch is '**/*.spec.ts', so this bun:test file (imports from 'bun:test', tests real-provider-preflight.ts) is never run by `test:e2e`; it is only picked up by the separate `test:e2e:bun` script. A contributor reading the directory name reasonably assumes everything in it runs under Playwright, which is false for this file.
- **[high]** `src/claxedo-ui/layouts/review-mount-retention.vitest.tsx` → `src/shell/chrome/review-region-policy.mount.vitest.tsx (colocated with its actual subject)`
  This file imports and exercises `reviewRegionPolicy` from `../../shell/chrome/review-region-policy` — a module that already has its own colocated `src/shell/chrome/review-region-policy.test.ts`. The DOM-mount variant of the same subject lives two directories away in claxedo-ui/layouts, split from its sibling test with no cross-reference.
- **[high]** `src/claxedo-ui/layouts/workspace-project-integrity.test.ts` → `src/context/layout-projects.test.ts`
  No sibling 'workspace-project-integrity.ts' exists in layouts/. The file's own header states it tests the pipeline driven by projectCatalog/canAutoOpenProject from @claxedo/context/layout-projects, with types inlined 'from rail-sidebar.tsx' via comment — its real subject lives in src/context/, not src/claxedo-ui/layouts/.

## Promote to directory

## Flatten / merge
- **[medium]** `src/claxedo-ui/state/tests/`: flatten: move metadata.test.ts, orchestration.test.ts, persistence.test.ts up to be siblings of metadata.ts / orchestration.ts / persistence.ts in src/claxedo-ui/state/, matching the other 14 test files in that same directory which are already flat siblings (agent-status-listener.test.ts, batch-autotab.test.ts, route-bridge.test.ts, etc.)
  Only 3 of 17 source files in state/ have their tests pulled into a tests/ subfolder; the other 14 are colocated flat. There is no naming or behavioral distinction (all 3 do map 1:1 to a source file) that explains why these three are singled out — it reads as an accident of history, not a convention.
- **[medium]** `src/claxedo-ui/layout/tests/`: rename the 14 lettered files to descriptive kebab-case names with no ordinal prefix (A-hydration.test.ts -> hydration.test.ts, F-mount-retention.vitest.tsx -> mount-retention.vitest.tsx, etc.); keep them in a tests/ folder only if formally adopted as a documented, sanctioned exception for behavior-level (cross-file) suites, otherwise flatten into layout/ as siblings
  This is the only place in the package where tests are named by ordinal letter (A-N) instead of by subject; the letters carry no information a contributor can use (no README explains the sequence) and this is the single directory package-wide using this scheme, making it an outlier a new contributor has no way to anticipate.
- **[low]** `src/e2e/`: consider flattening (single file: dialog-matrix-harness.tsx) into a more precisely named location, e.g. src/shell/debug/dialog-matrix-harness.tsx, or document why it deserves its own top-level dir
  Single-file directory whose name collides conceptually with the root e2e/ (playwright specs) even though it holds something different: a production-bundled debug harness component that app.tsx lazy-imports via the @claxedo/e2e/* alias and that e2e/playwright/dialog-matrix.spec.ts drives. Low priority since the alias is a real integration point, not just cosmetic, but the naming overlap invites confusion about which 'e2e' is being referenced.

## File naming
- `src/claxedo-ui/layouts/rail-layout.workspace-tools.vitest.tsx` → `src/claxedo-ui/layouts/rail-workspace-tools.vitest.tsx (or app-shell-layout.workspace-tools.vitest.tsx)`
  Filename cites a subject 'rail-layout' that does not exist anywhere in the tree (no rail-layout.ts/.tsx). The file actually mocks ./rail-sidebar and renders AppShellLayout from ../../shell/app-shell-layout. This is the concrete stale-name example flagged in the review brief.
- `src/claxedo-ui/layouts/workspace-icon-rendering.test.ts` → `no rename required, but the docstring must be corrected: it currently claims 'Test helpers mirror the CURRENT production code in rail-layout.tsx:676-711' — rail-layout.tsx does not exist; the logic now lives in rail-sidebar.tsx`
  A contributor who follows the docstring pointer to find the real implementation hits a dead file reference and has to rediscover the actual owner (rail-sidebar.tsx) by other means.
- `src/extensions/server.test.ts` → `src/extensions/server.vitest.ts (rename to match its actual import of "vitest", or rewrite the test body to use bun:test)`
  291 of 293 .test.ts files import from bun:test; this one imports describe/expect/test/vi from 'vitest' while still using the .test.ts suffix that signals bun:test everywhere else. It also falls outside vitest.config.ts's include glob (src/**/*.vitest.ts(x) only), so which runner actually executes it correctly is unclear.
- `src/claxedo-ui/navigation-islands/session-navigation.test.ts` → `src/claxedo-ui/navigation-islands/session-navigation.vitest.ts`
  Same defect as src/extensions/server.test.ts: imports describe/expect/test from 'vitest' but is named .test.ts, breaking the extension-signals-runner rule and excluding it from vitest's own include glob.
- `src/context/global-sync/bootstrap-integration.test.ts` → `src/context/global-sync/bootstrap.integration.test.ts`
  Every other integration-level test in the package uses a dot before 'integration' (persister.integration.test.ts, sync.streaming.integration.test.ts, surface-status.integration.test.ts, tab-page.integration.vitest.tsx). This file uses a hyphen ('bootstrap-integration'), which a `**/*.integration.test.ts` glob — the only mechanically enforceable way to find 'integration-level' tests — silently misses.

## Test location
- Two undocumented dedicated tests/ subfolders (src/claxedo-ui/layout/tests/, src/claxedo-ui/state/tests/) coexist with ~300 colocated sibling test files everywhere else in the package, with no README or naming convention explaining why these two directories are exceptions.
  Files: src/claxedo-ui/layout/tests/A-hydration.test.ts, src/claxedo-ui/layout/tests/N-reactivity.vitest.tsx, src/claxedo-ui/state/tests/metadata.test.ts, src/claxedo-ui/state/tests/orchestration.test.ts, src/claxedo-ui/state/tests/persistence.test.ts
  Proposal: Standardize on colocation everywhere except the one already-sanctioned, cross-cutting exception (src/architecture/*.guard.test.ts, which legitimately has no single subject file — it asserts invariants over the whole import graph, alongside its own baselines/allowlists/scanners.ts). Flatten state/tests/ into state/ as flat siblings (its 3 files map 1:1 to source files, so this is a pure move). For layout/tests/, either flatten similarly and drop the ordinal letters, or — if the team wants to keep a holistic 'walk the state machine end to end' suite distinct from per-file unit tests — rename it to something explicit like layout/behavior-tests/ with descriptive (non-lettered) filenames, and document the split in a short README so the exception is discoverable.
- Root e2e/ mixes three loose *.spec.ts files with the e2e/playwright/ directory that holds the other 28, and separately e2e/playwright/ contains one *.test.ts (bun:test) file even though playwright's testMatch is scoped to *.spec.ts — so the directory name does not reliably predict the runner.
  Files: e2e/restoration-e2e-1-local-workspace.spec.ts, e2e/restoration-e2e-2-cloud-vm.spec.ts, e2e/restoration-e2e-3-plugin-propagation.spec.ts, e2e/playwright/real-provider-preflight.test.ts
  Proposal: Move the 3 restoration-e2e-*.spec.ts files into e2e/playwright/ so all *.spec.ts live under one directory. For the .test.ts file mixed into e2e/playwright/, move it out to e2e/bun/ (joining workspace-relay-connection.test.ts) so 'playwright/' contains only playwright specs, or explicitly document that playwright/ intentionally mixes runners.
- No centralized shared-fixture location exists yet (src/utils/test-support/ is only planned per project memory, not built); the fixtures that do exist are either correctly root-level (test-fixtures/ for Playwright visual baselines) or are single-purpose, locally-scoped helpers with no cross-directory reuse path.
  Files: src/claxedo-ui/layout/tests/state-harness.ts, src/e2e/dialog-matrix-harness.tsx, test-fixtures/browser-parity/baseline-manifest.json, test-fixtures/p4-named-surfaces/baseline/rail-pinned-session-open.png
  Proposal: When src/utils/test-support/ is created, it should hold only cross-directory unit/vitest fakes reused by 2+ unrelated test files; layout/tests/state-harness.ts should move there if any other suite needs equivalent workbench-state builders. Leave test-fixtures/ at root as-is (correct home for binary/visual baselines consumed by Playwright — these should never live under src/). Do not fold src/e2e/dialog-matrix-harness.tsx into test-support/ — it is real, lazy-loaded application code (imported by src/app.tsx), not a test fixture, despite its name and directory.

## Proposed tree

```
e2e/
  playwright/                              # ALL *.spec.ts live here (rule: one flat, complete list)
    restoration-e2e-1-local-workspace.spec.ts   # moved from e2e/ root
    restoration-e2e-2-cloud-vm.spec.ts          # moved from e2e/ root
    restoration-e2e-3-plugin-propagation.spec.ts# moved from e2e/ root
    real-provider-preflight.ts
    ...(28 existing *.spec.ts)
  bun/                                      # ALL bun:test-run e2e files live here
    workspace-relay-connection.test.ts
    real-provider-preflight.test.ts          # moved out of playwright/
  playwright-global-setup.ts

src/
  architecture/                             # SANCTIONED exception: cross-cutting guard tests w/ no single subject file
    *.guard.test.ts + scanners.ts + *-baseline.json/allowlist.json (unchanged, already correct)
  claxedo-ui/
    layout/
      construct.ts / drag-drop.ts / keyboard.ts / selectors.ts / types.ts / validate.ts / provider.tsx / workbench.tsx / index.ts
      hydration.test.ts             # renamed from tests/A-hydration.test.ts, flattened, letter dropped
      contents.test.ts              # renamed from tests/B-contents.test.ts
      ...                           # (or: layout/behavior-tests/ if kept as an explicit documented exception)
    state/
      metadata.ts / metadata.test.ts              # flattened, was state/tests/metadata.test.ts
      orchestration.ts / orchestration.test.ts     # flattened, was state/tests/orchestration.test.ts
      persistence.ts / persistence.test.ts         # flattened, was state/tests/persistence.test.ts
      agent-status-listener.ts / .test.ts (unchanged, already flat)
    layouts/
      rail-sidebar.tsx
      rail-workspace-tools.vitest.tsx      # renamed from rail-layout.workspace-tools.vitest.tsx
      workspace-icon-rendering.test.ts     # docstring fixed to point at rail-sidebar.tsx, not deleted rail-layout.tsx
      # workspace-project-integrity.test.ts MOVED OUT (see below)
      # review-mount-retention.vitest.tsx MOVED OUT (see below)
  context/
    layout-projects.ts
    layout-projects.test.ts             # moved from claxedo-ui/layouts/workspace-project-integrity.test.ts
    global-sync/
      bootstrap.ts
      bootstrap.test.ts
      bootstrap.integration.test.ts     # renamed from bootstrap-integration.test.ts (dot, not hyphen)
  extensions/
    server.ts
    server.vitest.ts                     # renamed from server.test.ts (imports vitest, not bun:test)
  shell/
    chrome/
      review-region-policy.ts
      review-region-policy.test.ts
      review-region-policy.mount.vitest.tsx   # moved from claxedo-ui/layouts/review-mount-retention.vitest.tsx
  utils/
    test-support/                        # NEW: only for fixtures reused across 2+ unrelated test files

```
