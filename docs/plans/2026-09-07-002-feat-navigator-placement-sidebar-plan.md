---
title: "feat: WorkspacePanelNavigator placement — files / changes / processes as a secondary left sidebar, full-view panel by default, floating composer"
status: superseded 2026-09-07: the secondary sidebar was removed after use; the classic workspace panel is the only placement, the floating full-view presentation and the panel behavior stay
type: feat
date: 2026-09-07
baseline: 4f668ebf18
package: packages/claxedo-app
backward_compatibility: none — the current placement stays the default; no migration of persisted state, no legacy shims
related: ../../packages/claxedo-app/src/ARCHITECTURE.md, ../../packages/claxedo-app/src/app/layout/AGENTS.md
---

# feat: WorkspacePanelNavigator placement

## Overview

Superseded 2026-09-07: the secondary sidebar was removed after use; the classic workspace panel is the only placement, the floating full-view presentation and the panel behavior stay.

**WorkspacePanelNavigator** is the existing code name for the three workspace navigators: the Files tree, the Changes list and the Processes list (`WorkspacePanelNavigator = "files" | "changes" | "processes"`). They are one thing to the user (the trio in the workbench header) and one thing in code, so the preference and every new symbol in this plan use that name, shortened to **Navigator** in prose.

Today the Navigator renders as navigator columns inside the right-side workspace panel: open Changes and a 520px panel slides in from the right with the changes list on one edge and the review body beside it, squeezing the session column. That is the only placement the shell knows.

This plan adds one preference, `appearance.navigatorPlacement: "panel" | "sidebar"`, and one alternate layout preset the shell renders when it is `sidebar`:

- The **Navigator becomes a secondary left sidebar**, to the right of the primary sidebar (the rail), with three tabs: **Files**, **Changes**, **Processes**, bound to the workspace of the focused pane.
- The **workspace panel opens at full view by default**. It covers the workbench column instead of squeezing it and renders no navigator columns, because those now live in the Navigator sidebar. The existing restore control stays: the user can leave full view, and the panel and the session then sit side by side as they do today.
- While the panel is at full view, the **session pane switches to a floating presentation**: only the last turn is rendered, above a floating composer, with an **"N previous messages"** row that reveals the rest on click. Nothing is remounted; the same timeline and the same composer change container geometry. When the user leaves full view the session returns to its normal docked layout.

The rail, its session tree, and the classic placement are untouched. The mode is a branch inside the one existing shell path; the layout guard that pins a single shell entrypoint must stay green.

This task produces a plan. Implementation has not started.

## Problem Frame

The driver is muscle memory from VS Code: explorer on the left, content on the right. Three things in the current shell fight that:

1. **The Navigator is welded to the right-side panel.** `RailWorkspacePanelShell` is `absolute right-0 z-30` inside the `role="main"` region ([workspace-panel.tsx:384](../../packages/claxedo-app/src/features/workspaces/ui/panel/workspace-panel.tsx#L384)); the workbench column yields room through an animated `margin-right` ([rail-workbench-shell.tsx:95-105](../../packages/claxedo-app/src/app/workbench/rail/rail-workbench-shell.tsx#L95)). Files and processes are columns *inside* that panel ([workspace-panel-body.tsx:432-546](../../packages/claxedo-app/src/app/workbench/rail/workspace-panel-body.tsx#L432)), so there is no way to see the file tree without also opening the review body on the right.
2. **Full view hides the session, composer included.** The existing full-width toggle ([commands.ts:9](../../packages/claxedo-app/src/app/layout/commands.ts#L9)) sets the panel to 100% and the column's `margin-right` follows it, so the session column collapses to zero width ([workspace-panel.tsx:194](../../packages/claxedo-app/src/features/workspaces/ui/panel/workspace-panel.tsx#L194)). Reading a diff at full width means losing the conversation.
3. **The layout model is only half real.** `LayoutConfig` already carries `presetId`, region sides, orders and grid helpers ([config.ts:38-45](../../packages/claxedo-app/src/app/layout/config.ts#L38), [config.ts:157-200](../../packages/claxedo-app/src/app/layout/config.ts#L157)), and its tests prove alternate placements through config alone ([config.test.ts:150](../../packages/claxedo-app/src/app/layout/config.test.ts#L150), [:184](../../packages/claxedo-app/src/app/layout/config.test.ts#L184)). Nothing outside `app/layout/` reads `presetId`, `sessionMode`, `chromeGridDefinition` or `chromeRegionPlacement`. The shell hand-composes flexbox and reads only `regions.rail` and `regions.workspacePanel`.

The plan makes `presetId` load-bearing and adds one region. It does **not** replace the flex composition with the grid helpers; that is a separate refactor with its own risk (imperative motion DOM writes, breakpoint overrides, the absolute panel).

## Requirements Trace

### The preference
- One app-wide enum preference, `appearance.navigatorPlacement`, persisted with the other appearance settings, default `panel`.
- Rendered in Settings → General → Appearance with literal i18n keys in all 17 locales.
- Changing it re-lays out the live shell without reload and without remounting open surfaces.

### The Navigator sidebar
- Appears only when the placement is `sidebar`, between the rail and the workbench, resizable, width and active tab persisted.
- Tabs: Files, Changes, Processes, using the semantic icon registry (`file`, `review`, `console`), never ad hoc glyphs.
- Binds to the workspace of the focused pane and follows focus; with no workspace target it shows the same empty state the header trio uses.
- Selecting a file, change or process opens the workspace panel with that target focused, through the same panel state the classic placement uses.

### The workspace panel in sidebar placement
- Opens at full view by default; the restore control leaves full view and the panel then sits beside the session at its persisted width, as today.
- Renders no navigator columns in either width.
- The header trio and the existing keyboard commands select the matching Navigator tab and open the panel.

### The session pane while the panel is at full view
- Renders in floating presentation: last turn only, floating composer, an "N previous messages" row.
- Clicking the row reveals the full history in place, preserving scroll and without remounting the composer.
- Leaving full view, or closing the panel, returns the pane to docked presentation and the full timeline.
- The composer is one instance; no second `PromptInput` mount is introduced.

### Non-regression
- The rail is not modified. Sessions, projects, workspaces, view options and the account footer stay exactly where they are in both placements.
- Panel placement: pixel and behavior identical to today except the intended maximize change; every existing rail, panel, composer and timeline test stays green unchanged, except where a test hard-codes the old scroll-only history reveal or the old hidden-session maximize.
- Narrow viewports (below `BP_MD`) keep the drawer and sheet behavior; the Navigator sidebar does not render there.
- The layout guard's one-shell-path baseline does not grow.

## Scope Boundaries

**In scope.** `packages/claxedo-app/src/app/layout/**`, `app/workbench/rail/` (panel shell, body, header, controller, visual state only), `app/workbench/state/**`, a new `app/workbench/navigator-sidebar/**`, `app/app-shell-layout.tsx`, `features/session/ui/**` (presentation, history window, timeline row), `features/settings/ui/general.tsx`, `platform/settings/provider.tsx`, `platform/i18n/**`, and the Playwright suite under `packages/claxedo-app/e2e/`.

**Explicitly out of scope.**
- Any change to `rail-sidebar.tsx`, `rail-sidebar-shell.tsx`, the session tree, or the rail's persisted state.
- Replacing the flex shell with `chromeGridDefinition` / `chromeRegionPlacement`. Named in System-Wide Impact as follow-up debt.
- A right-side rail, a bottom panel, or any third preset. The preset type is a two-member union.
- Persisting the "previous messages" expanded state across reloads. It resets to collapsed when the pane enters floating presentation.
- Mobile-specific Navigator behavior. Below `BP_MD` the placement is ignored.
- The duplicated rail hot-zone logic between `app/workbench/state/rail.ts` and `app/layout/state.ts`. Noted, not touched.

## Context & Research

### A. The preference layer is ready; the key registry is not what it looks like
`platform/settings/provider.tsx` holds the `Settings` interface (lines 22-53), `defaultSettings` (108-149) and the accessor object (196-362). `appearance.navigatorSide: "left" | "right"` (line 45, default at 130, accessor at 291-294) is the only existing layout-shaped enum preference and is the template. The store persists as one blob under `settings.v3` (line 180); `merge` in [persist.ts:164-188](../../packages/claxedo-app/src/platform/persistence/persist.ts#L164) supplies defaults for new keys, so **no version bump and no new key** are needed. `platform/persistence/keys.ts` is three lines and classifies projection cache keys only. `app/workbench/preferences/` contains only an `AGENTS.md` describing a file that does not exist.

### B. i18n is at 100% parity and enforces it
`platform/i18n/en.ts` is a flat literal-key dictionary; `locale-parity.test.ts` asserts each of the 16 non-English locales' missing-key set equals its `missing-keys-baseline.json` entry, and every entry is currently empty. The `followup` row (en.ts:763-766) is the enum precedent. The only dynamic template key in the codebase needs a lying cast ([rail-sidebar.tsx:1811](../../packages/claxedo-app/src/app/workbench/rail/rail-sidebar.tsx#L1811)); a literal `Record` lookup is the pattern to follow.

### C. `LayoutConfig` is derived, never persisted, and carries inert preset fields
`createShellLayoutState` ([state.ts:30](../../packages/claxedo-app/src/app/layout/state.ts#L30)) rebuilds the config from the flat `rail` / `workspacePanel` slices and reduces three latched commands over it (`rail → workspacePanelVisibility → workspacePanelSize`). Full view is encoded as `size = {percent, 100}`, dispatched as a command and cleared rather than inverted ([app-shell-layout.tsx:308-321](../../packages/claxedo-app/src/app/app-shell-layout.tsx#L308)); closing the panel clears the size slot so a reopened panel is never maximized. `presetId` defaults to `"claxedo.default"` and nothing reads it. `target` is set but nothing branches on it.

### D. The Navigator already has a name in code, and the panel already knows how to hide it
`WorkspacePanelNavigator = "files" | "changes" | "processes"` and `navigatorHidden` exist on the panel state ([workspace-panel-state.ts:39-48](../../packages/claxedo-app/src/features/workspaces/ui/panel/workspace-panel-state.ts#L39)). `WorkspacePanelMode` declares four values but every caller passes `review` and the body never branches on it. The navigators push focus into the panel via `claxedoState.workspacePanel.retarget(...)` ([workspace-panel-body.tsx:456](../../packages/claxedo-app/src/app/workbench/rail/workspace-panel-body.tsx#L456), [:535](../../packages/claxedo-app/src/app/workbench/rail/workspace-panel-body.tsx#L535)) and `ReviewWorkspace` opens the matching tab. The navigators need `SessionPaneScope` and `ProcessPaneProvider` above them ([workspace-panel-body.tsx:405-414](../../packages/claxedo-app/src/app/workbench/rail/workspace-panel-body.tsx#L405)); a test pins one process provider per panel ([rail-workspace-tools.vitest.tsx:312](../../packages/claxedo-app/src/app/workbench/rail/rail-workspace-tools.vitest.tsx#L312)). The navigator components are `WorkspaceFilesNavigator` (`mode: "files" | "changes"`, [files-navigator.tsx:91](../../packages/claxedo-app/src/app/workbench/workspace-panel/files-navigator.tsx#L91)) and `WorkspaceProcessesNavigator` ([workspace-processes-navigator.tsx:94](../../packages/claxedo-app/src/features/processes/ui/workspace-panel/workspace-processes-navigator.tsx#L94)).

### E. Full view today squeezes the column to zero, and the maximize control is gated
`restingPanelWidth()` returns the available width under `fullWidth` and the column's `margin-right` follows it. The panel also mutates transform and margin imperatively at click time ([workspace-panel-motion-state.ts:93-120](../../packages/claxedo-app/src/app/workbench/rail/workspace-panel-motion-state.ts#L93)). The maximize / restore button is `WorkspacePanelChrome` ([workbench-shell-header.tsx:23-59](../../packages/claxedo-app/src/app/workbench/rail/workbench-shell-header.tsx#L23)), rendered only in the panel's own L1 header behind `allowFullWidth`. A floating session presentation cannot live inside the squeezed column; it must overlay the `role="main"` region.

### F. The composer is a flex sibling, not an overlay, and the last-turn window already exists
`SessionComposerRegion` ([session-composer-region.tsx:57](../../packages/claxedo-app/src/features/session/ui/composer/session-composer-region.tsx#L57)) renders `data-component="session-prompt-dock"` as a `shrink-0` sibling of the timeline inside `SessionPage` ([session-screen.tsx:1190-1434](../../packages/claxedo-app/src/features/session/ui/session-screen.tsx#L1190)). `createSessionHistoryWindow` ([history-window.ts:30](../../packages/claxedo-app/src/features/session/ui/history-window.ts#L30)) already computes `turnStart` with `turnInit = 4` and exposes `setTurnStart` / `loadAndReveal` / `preserveScroll`; the hidden-turn count is `visibleUserMessages().length - turnStart()` and is already stamped on the root ([session-screen.tsx:1183-1184](../../packages/claxedo-app/src/features/session/ui/session-screen.tsx#L1183)). Reveal is scroll-only today, `createHistoryFill` auto-reveals when the viewport is short, and `boundColdFinalTurn` is a first-paint device that self-expands on any scroll. `TurnFoldRow` ([message-timeline-turn-rows.tsx:41](../../packages/claxedo-app/src/features/session/ui/message-timeline-turn-rows.tsx#L41)) is the visual precedent for a clickable collapsed row. `SessionQuestionDock` queries `.scroll-view__viewport` and the dock by selector for its scroll math ([session-question-dock.tsx:135-190](../../packages/claxedo-app/src/features/session/ui/composer/session-question-dock.tsx#L135)).

### G. Two guards constrain the shell
`layout.guard.test.ts` pins exactly one shell entrypoint via `layout-guard-baseline.json`; `composer-mode.guard.test.ts` requires every `PromptInput` mount to pass an explicit mode. Rail geometry persists inside `claxedo.state.v5` via the `rail` slice, validated in [persistence.ts:97-107](../../packages/claxedo-app/src/app/workbench/state/persistence.ts#L97); the Navigator's geometry goes beside it.

## Key Technical Decisions

1. **The preference is `appearance.navigatorPlacement`, in `settings.v3`.** It names the thing it positions. Settings are what the user chooses; geometry the placement introduces (Navigator width, active tab) goes in `claxedo.state.v5` beside `rail`.
2. **`presetId` becomes real.** `defaultLayoutConfig({ target, preset })` produces the region set; `"claxedo.navigator-sidebar"` adds an `navigator` builtin slot on the left at order 1 and bases the panel's size at `{percent, 100}`. The shell reads the preset from the preference and passes it into `createShellLayoutState` as an accessor, so switching re-derives the config without reload.
3. **Full view is the base, restore is the command.** In the sidebar preset the size slot's meaning inverts: the base config is percent 100, and `workspacePanelFullWidthCommand` toggles to the persisted px width. `WorkspacePanelChrome` is shown (`allowFullWidth` true) so the user can leave full view; closing the panel clears the slot, so the next open is full again.
4. **Flex stays; the grid helpers stay unused.** The Navigator sidebar mounts as a flex sibling between the rail `<nav>` and `RailWorkbenchShell`.
5. **Full view means overlay, not squeeze.** When the panel is at percent 100 the workbench column's `margin-right` is pinned to `0px` and the panel covers it at its existing `z-30`. When the user restores px width the column squeezes as today.
6. **Floating presentation is keyed to full view, not to the placement.** `PaneCtx.presentation` is `"floating"` whenever the panel targeting this pane is at percent 100. This is what makes "exit full view → session appears as usual" fall out for free. It also changes the classic-placement maximize, which today hides the composer: maximizing now floats the session. That is intended (owner decision, 2026-09-07), not a side effect to be gated away.
7. **One composer, one timeline, two presentations.** `SessionPage` receives `presentation` through `PaneCtx`. Floating changes container geometry and the history window's initial turn count; it mounts nothing new.
8. **The Navigator sidebar drives the existing panel state.** Its tabs call `claxedoState.workspacePanel.retarget` / `open` with `navigatorHidden: true` and the same focus payloads the in-panel navigators send today. `ReviewWorkspace` is unchanged.
9. **The placement is desktop-width only.** Below `BP_MD` the preset resolves to classic.

## Open Questions

### Resolved during planning
- **Does floating presentation also apply when the user maximizes the panel in classic placement?** Yes, by owner decision. Keying it to full view rather than to the placement gives one rule and removes today's "maximize hides the composer" behavior in both placements.
- **After the user restores px width, does the next open go back to full?** Yes, "defaults to full" is read literally: the sidebar preset's base is full, and closing clears the size slot exactly as today. If a sticky choice turns out to be better, persist the slot beside the Navigator geometry; it is a one-slice change.
- **Does "N previous messages" persist?** No. It resets to collapsed whenever the pane enters floating presentation.
- **Can the Navigator sidebar collapse?** Not in this plan. It is resizable within 260-520px.

### Deferred to implementation
- Whether `ProcessPaneProvider` can be hoisted so the Navigator's Processes tab and the panel body share one provider per workspace, or whether the sidebar owns one keyed by target. Unit 0 reads `features/processes/providers/process-pane.tsx` and the one-provider test and writes the answer into Unit 4's brief.
- The floating stack's max height for the last turn (proposed `min(40vh, 28rem)`). Settle by browser-use video during Unit 6.

## High-Level Technical Design

Plain-English flows first; every name below exists today unless marked *(new)*.

### Flow 1 — the user flips the setting

A. `SettingsGeneral` ([general.tsx](../../packages/claxedo-app/src/features/settings/ui/general.tsx)) → A.1 a new `SettingsRow` "Navigator placement" with a `Select` over `panel | sidebar` → A.1.1 `settings.appearance.setNavigatorPlacement(value)` *(new)* writes `store.appearance.navigatorPlacement` → persisted under `settings.v3`; `phCapture("setting_changed", { setting: "navigator_placement", value })`.

B. `AppShellLayoutBody` ([app-shell-layout.tsx:194](../../packages/claxedo-app/src/app/app-shell-layout.tsx#L194)) → B.1 `layoutPreset = () => isNarrowViewport() ? "claxedo.default" : presetForNavigatorPlacement(settings.appearance.navigatorPlacement())` *(new)* → B.2 `createShellLayoutState({ target, preset: layoutPreset, initialRail, initialWorkspacePanel, initialNavigator })` re-derives `config()` because `baseConfig()` now reads `preset()` → B.3 `regions.navigator.visible` becomes true → B.4 the shell mounts `NavigatorSidebar` *(new)* between the `<nav>` and `RailWorkbenchShell`. The rail receives nothing new. Open surfaces are untouched.

### Flow 2 — the user clicks a changed file in the Navigator

A. `NavigatorSidebar` *(new)* → A.1 tab strip sets `claxedoState.navigator.select("changes")` *(new slice)* → A.2 body mounts `WorkspaceFilesNavigator mode="changes"` inside `SessionPaneScope` + `ProcessPaneProvider` for `focusedPanelTarget()` ([rail-workspace-panel-target.ts:68](../../packages/claxedo-app/src/app/workbench/rail/rail-workspace-panel-target.ts#L68)).

B. Click → B.1 `onFileClick(path, "review")` → B.2 `claxedoState.workspacePanel.retarget({ workspaceDir, targetPaneId, mode: "review", navigator: "changes", navigatorHidden: true, focus: { kind: "file", path, intent: "review" } })` → B.3 `useWorkspacePanelVisualState` sees `open && mode` and a target, so `workspacePanelOpen()` flips → B.4 in the sidebar preset the base size is `{percent, 100}` and the size slot is empty, so `RailWorkspacePanelShell` renders at full view and `rail-workbench-shell.tsx` pins `margin-right` to `0px` → B.5 `WorkspacePanelBody` reads `navigatorHidden` and renders `ReviewWorkspace` alone → B.6 `ReviewWorkspace` consumes `state.focus` and opens the file's review tab, exactly as today.

C. The user clicks restore in the panel's L1 header → C.1 `toggleWorkspacePanelFullWidth` dispatches `workspacePanelSize` with the px command → C.2 the panel is 520px (or the persisted width), `margin-right` follows it, the session pane is beside it and docked, as today. Closing the panel clears the slot.

If the panel is already open with the same target, only the focus version changes and no motion runs. With no workspace target (a global surface) the Navigator renders the header trio's empty state.

### Flow 3 — the session pane floats

A. `app/workbench/content/index.tsx:88` builds `PaneCtx` per pane → A.1 adds `presentation: () => panelAtFullViewForPane(paneId)() ? "floating" : "docked"` *(new)*, derived from `workspacePanelMatchesFocusedPane` ([workspace-panel-visual-state.ts:12](../../packages/claxedo-app/src/app/workbench/rail/workspace-panel-visual-state.ts#L12)) and `regions.workspacePanel.size`.

B. `SessionContent` ([session-content.tsx:31](../../packages/claxedo-app/src/features/session/ui/content/session-content.tsx#L31)) → B.1 stamps `data-session-presentation` on `.session-envcard-shell` and suppresses `DeferredEnvironmentCard` while floating (the panel is showing the changes) → B.2 `SessionPage` receives `presentation`.

C. `SessionPage` ([session-screen.tsx:1189-1434](../../packages/claxedo-app/src/features/session/ui/session-screen.tsx#L1189)) → C.1 when floating, the `@container` column becomes `absolute inset-x-0 bottom-0 z-40 pointer-events-none` and centers a `max-w-192` floating stack with `pointer-events-auto` → C.2 the timeline container gets `max-height: var(--session-floating-turn-height)` and stays the same `MessageTimeline` instance → C.3 `SessionComposerRegion` keeps its place at the bottom of the stack; its surface switches to `--surface-raised-strong` + `--shadow-lg-border-base` → C.4 `createSessionHistoryWindow({ turnInit: floating ? 1 : 4, autoFill: !floating })` *(new options)*; entering floating calls `collapseToLastTurn()` *(new)*.

D. `MessageTimeline` → D.1 `timelineRows` emits a `PreviousMessages` row *(new tag in `TimelineRowMap`)* at the head when `turnStart() > 0`, carrying `count` → D.2 `VirtualTimelineRow` renders `PreviousMessagesRow` *(new, beside `TurnFoldRow`)* with `aria-expanded` → D.3 click → `historyWindow.loadAndReveal(0)` inside `preserveScroll`, which also pages older server history when the local list is shorter than the session.

E. Leaving floating (restore, close, or preference flip) → `turnStart` returns to the docked default and the column returns to flex flow. The composer element is never unmounted, so focus, draft text and docks survive.

Edge behavior: `SessionQuestionDock`'s selector-based scroll math subtracts the dock height when the dock overlaps the viewport; the resting-height placeholder and the `lift` memo are skipped while floating; `focusComposerSurface` is unchanged because the editor node keeps `data-component="prompt-input"`.

## Implementation Units

All units are unstarted. Paths are repository-relative under `packages/claxedo-app/src/` unless stated. Files marked new are proposed. Each unit lands complete with its tests; no unit leaves two implementations of one responsibility behind.

- [ ] **Unit 0: Consumer map and provider research**
  - Requirements: disjoint ownership for the parallel units; an answer on `ProcessPaneProvider`. Dependencies: none.
  - Owners: read-only across `app/layout/**`, `app/workbench/rail/**`, `app/workbench/state/**`, `features/session/ui/**`, `features/processes/providers/**`.
  - Tests: none new.
  - Record every reader of `regions.workspacePanel`, `workspacePanelFullWidth`, `allowFullWidth`, `navigatorHidden`, `turnInit`, and every `vi.mock("@/platform/settings/provider")` that stubs `appearance` (known: `review-mount-retention.vitest.tsx:22`, `rail-workspace-tools.vitest.tsx:113`, `workspace-panel-disposal.vitest.tsx:155`). Decide the provider question and write it into Unit 4's brief.
  - Done when the ownership map has no overlap between concurrent units and the provider decision is written with evidence.

- [ ] **Unit 1: The preference**
  - Requirements: one enum preference, persisted, in Settings, telemetry, 17 locales. Dependencies: none.
  - Owners: `platform/settings/provider.tsx`, `features/settings/ui/general.tsx`, `platform/i18n/en.ts` and the 16 locale files, `platform/settings/provider.test.ts`, the three vitest mocks named in Unit 0.
  - Tests: `provider.test.ts` gains a case that `migrateSettings` passes `appearance.navigatorPlacement` through and that the default is `panel`; new `features/settings/ui/general.vitest.tsx` renders the Appearance section and asserts `data-action="settings-navigator-placement"` drives `setNavigatorPlacement`; `locale-parity.test.ts` stays green with all baseline arrays empty.
  - Add `NAVIGATOR_PLACEMENTS = ["panel", "sidebar"] as const`, `NavigatorPlacement`, the interface field, the default, `navigatorPlacement` / `setNavigatorPlacement` beside `navigatorSide`. Add the four literal keys `settings.general.row.navigatorPlacement.{title,description,option.panel,option.sidebar}` to every locale. Render the row with `language.t` and capture `setting_changed`. Delete `app/workbench/preferences/` (a stale `AGENTS.md` only) and update `agents-md.guard.test.ts` if it lists the directory.
  - Done when the setting round-trips through `settings.v3`, the row is visible and localized, the three mocks carry `navigatorPlacement`, and the stale directory is gone.

- [ ] **Unit 2: The preset and the `navigator` region**
  - Requirements: `presetId` load-bearing; one new region; full view as the sidebar preset's base with restore as the command. Dependencies: none.
  - Owners: `app/layout/config.ts`, `app/layout/commands.ts`, `app/layout/state.ts`, their tests, `app/layout/AGENTS.md`.
  - Tests: `config.test.ts` gains "navigator-sidebar preset adds a left `navigator` region at order 1 and bases the panel at percent 100", "default preset is byte-identical to today's config", "migration keeps an unknown preset id as default"; `commands.test.ts` gains `navigatorResizeCommand` clamping and "full-width command inverts under the navigator-sidebar preset: percent 100 → px restore width → percent 100"; `state.test.ts` gains "switching the preset accessor re-derives the config and keeps the latched rail command" and "closing the panel clears the size slot so the next open is full under the sidebar preset"; `state.vitest.tsx` gains a DOM case for `--claxedo-navigator-width`.
  - Add `LayoutPreset = "claxedo.default" | "claxedo.navigator-sidebar"`, `BuiltinSlotKind` member `"navigator"`, `defaultLayoutConfig({ target, preset })`, `layoutConfigFromLiveChromeState({ preset, navigator })`, `navigatorResizeCommand(width, { minWidth: 260, maxWidth: 520 })`, and a `preset: Accessor<LayoutPreset>` plus `initialNavigator: { width }` input to `createShellLayoutState` with `navigatorWidth` / `setNavigatorWidth`. `workspacePanelFullWidthCommand` already toggles between percent 100 and px; under the sidebar preset the base is percent 100 so the same command restores. Leave `chromeGridDefinition` and `sessionMode` untouched.
  - Done when the default preset produces today's config exactly, the sidebar preset is fully described by config, and every command test passes in both presets.

- [ ] **Unit 3: Persisted Navigator geometry**
  - Requirements: Navigator width and active tab survive reload beside rail geometry. Dependencies: none.
  - Owners: `app/workbench/state/types.ts`, `app/workbench/state/persistence.ts`, `app/workbench/state/provider.tsx`, new `app/workbench/state/navigator.ts`, `app/workbench/state/index.ts`, `persistence.test.ts`.
  - Tests: `persistence.test.ts` gains "validates `navigator` (width clamped 260-520, tab in the three-member union, defaults `{ width: 320, tab: "changes" }`)" and "a v5 blob without the slice loads with defaults".
  - Add `NavigatorSlice = { width: number; tab: WorkspacePanelNavigator }`, `createNavigatorSlice` exposing `width`, `tab`, `setWidth`, `select`, registered on `ClaxedoStateApi`. Seed `createShellLayoutState` from it and write back on drag end, mirroring `claxedoState.rail.setWidth` at [app-shell-layout.tsx:337](../../packages/claxedo-app/src/app/app-shell-layout.tsx#L337). Reuse `WorkspacePanelNavigator` for the tab type; do not mint a second union.
  - Done when the slice persists under `claxedo.state.v5`, the validator rejects malformed input, and existing blobs load unchanged.

- [ ] **Unit 4: `NavigatorSidebar`**
  - Requirements: the three-tab secondary sidebar bound to the focused pane; selection drives the panel. Dependencies: Units 2, 3, Unit 0's provider decision.
  - Owners: new `app/workbench/navigator-sidebar/navigator-sidebar.tsx`, `navigator-sidebar-tabs.tsx`, `navigator-sidebar.css`, `AGENTS.md`; `app/app-shell-layout.tsx` (mount, width plumbing, the preset accessor); `app/workbench/rail/rail-workbench-controller.ts` (`toggleFocusedWorkspaceNavigator` routes to the Navigator tab when the placement is `sidebar`).
  - Tests: new `navigator-sidebar.vitest.tsx`: tabs render with `SemanticIcon` concepts `file` / `review` / `console`, Files and Changes mount `WorkspaceFilesNavigator` with the right `mode`, Processes mounts `WorkspaceProcessesNavigator`, a file click calls `workspacePanel.retarget` with `navigatorHidden: true` and the review focus, a target-less pane shows the empty state, the resize separator has `role="separator"` with `aria-valuemin/max`; `rail-keyboard-commands.test.ts` gains "Files / Changes / Processes commands select the Navigator tab in sidebar placement".
  - The sidebar is `aside[data-testid="navigator-sidebar"]` with `data-tab`; hairline dividers, no boxed cards. It mounts inside the existing `<nav class="contents">` landmark after `RailSidebarShell`. Width comes from `regions.navigator.size`, drag goes through `shellLayout.setNavigatorWidth`, commit writes `claxedoState.navigator.setWidth`.
  - Done when every tab works against a live local workspace, the header trio and `mod`-commands land on the Navigator tab, and the panel-placement DOM contains no `navigator-sidebar` node.

- [ ] **Unit 5: The panel in sidebar placement**
  - Requirements: full view by default without squeezing; restore available; no navigator columns. Dependencies: Unit 2.
  - Owners: `app/workbench/rail/rail-workbench-shell.tsx`, `app/workbench/rail/workspace-panel-body.tsx`, `app/workbench/rail/workbench-shell-header.tsx`, `app/workbench/rail/workspace-panel-visual-state.ts`, `app/workbench/rail/workspace-panel-motion-state.ts`, `features/workspaces/ui/panel/workspace-panel.tsx`, their vitest files.
  - Tests: `workspace-panel.vitest.tsx` gains "percent-100 size renders at available width without a resize handle and without changing the retained body identity, then restores to px with the handle back"; `rail-workspace-tools.vitest.tsx` gains "navigatorHidden renders no `workspace-navigator-overlay`"; `workbench-shell-header.vitest.tsx` gains "sidebar placement shows the restore control in the L1 header"; `workspace-panel-motion-state.vitest.ts` gains "the column margin is `0px` while the panel is percent 100 and follows the px width otherwise, on both the reactive and the click-time path".
  - One `workbenchColumnMargin(config)` function feeds both `rail-workbench-shell.tsx` and `applyWorkspacePanelMotionDom`, so the two paths cannot disagree. `WorkspacePanelBody` honors `navigatorHidden` for both navigator columns and the pending skeleton. `WorkspacePanelChrome` receives `allowFullWidth` true in sidebar placement from the one place that already gates it.
  - Done when opening the panel in sidebar placement covers the column, restore brings back the side-by-side layout, and panel-placement motion tests are unchanged.

- [ ] **Unit 6: Floating session presentation**
  - Requirements: one composer, one timeline, a floating stack while the panel is at full view. Dependencies: none for the code; Unit 5 for the live check.
  - Owners: `app/workbench/content/index.tsx` (`PaneCtx.presentation`), `app/integrations/content-surface-contract.ts` if `PaneCtx` is declared there, `features/session/ui/content/session-content.tsx`, `features/session/ui/session-screen.tsx`, `features/session/ui/composer/session-composer-region.tsx`, `features/session/ui/composer/session-question-dock.tsx`, `features/session/ui/content/session-environment-card.css`, new `features/session/ui/session-presentation.css`.
  - Tests: `session-content.vitest.tsx` gains "floating presentation stamps `data-session-presentation` and mounts no environment card"; new `session-presentation.vitest.tsx` asserts the same `PromptInput` node identity across docked → floating → docked and that `focusComposerSurface` still resolves it; `composer-mode.guard.test.ts` stays green with no new mount site; `session-question-dock-nav.test.ts` gains the overlap case.
  - The floating stack is positioned against the `role="main"` region, centered at the composer's existing max width, `z-40`, `pointer-events-none` with `pointer-events-auto` on the stack. The dock surface uses the raised-surface tokens the context card already uses. The resting-height placeholder and the `lift` memo are skipped while floating. The environment-card gutter rules do not apply while floating.
  - Done when a session floats over a full-view panel with the composer usable, every dock (permission, question, todo, followup) renders inside the floating stack, and docked mode is byte-identical in the DOM.

- [ ] **Unit 7: Last turn window and "N previous messages"**
  - Requirements: last turn only while floating; a clickable reveal row; scroll preserved. Dependencies: none (feature-local; Unit 6 wires the option).
  - Owners: `features/session/ui/history-window.ts`, `history-fill.ts`, `timeline-row-model.ts`, `timeline-row-equality.ts`, `message-timeline.tsx`, `message-timeline-turn-rows.tsx`, `platform/i18n/**` (one key `session.timeline.previousMessages` with a `{{count}}` placeholder in all locales), the matching tests.
  - Tests: `history-window.test.ts` gains "turnInit 1 renders only the last turn", "`collapseToLastTurn()` sets `turnStart` to the last index", "`loadAndReveal(0)` pages server history when the local list is shorter"; `history-fill.test.ts` gains "autoFill false never reveals"; `message-timeline-row-reuse.test.ts` gains the `PreviousMessages` row equality; a vitest render asserts the row's `aria-expanded` and count text; `e2e/playwright/core-timeline-rendering-scroll.spec.ts:870` is updated to cover both scroll reveal (docked) and click reveal (floating).
  - Add `turnInit` and `autoFill` options to `createSessionHistoryWindow`, a `collapseToLastTurn()` method, the `PreviousMessages` row tag emitted once at the head of `timelineRows`, and `PreviousMessagesRow` rendered beside `TurnFoldRow`. Do not reuse `boundColdFinalTurn`.
  - Done when the count matches `visibleUserMessages().length - turnStart()`, one click reveals everything with the last turn's scroll position preserved, and docked mode's scroll-driven reveal is unchanged.

- [ ] **Unit 8: End-to-end proof and gates**
  - Requirements: the placement proven through the real app; every guard green. Dependencies: Units 1-7.
  - Owners: new `packages/claxedo-app/e2e/playwright/core-navigator-sidebar.spec.ts`, `e2e/helpers/rail-oracle.ts` (a `navigatorSidebar` oracle, additive; the rail contract unchanged), `mobile-smoke.spec.ts` (one assertion that the Navigator does not render below `BP_MD`).
  - Tests: the new spec, on the signed local web harness: enable the setting → the Navigator sidebar appears with three tabs and the rail DOM is unchanged (rail-oracle) → Changes lists the seeded uncommitted files → clicking one opens the panel at full view with the review tab focused and no navigator overlay → the session floats with "N previous messages" showing the seeded count → clicking reveals the full history → restore brings the panel to px width beside the docked session → close, reopen: full view again → switching the setting back restores the classic DOM. Record a browser-use video of the open / restore / close motion and the reveal.
  - Gates: `bun run typecheck` in `packages/claxedo-app`; the package's `bun:test` runner and its vitest runner (two runners, run both); `bun run test:architecture-ratchets` at the root; `layout.guard.test.ts` baseline unchanged; `composer-mode.guard.test.ts`; `debt-ratchet.test.ts` (if a metric moves, explain exactly which files, no blanket rebaseline); the e2e shard runner with the CI env set.
  - Done when the spec passes locally in CI's container and every command and its outcome is recorded in the PR description.

- [ ] **Unit 9: Documentation**
  - Requirements: docs describe live code. Dependencies: Unit 8.
  - Owners: `app/layout/AGENTS.md` (the preset and the `navigator` region), new `app/workbench/navigator-sidebar/AGENTS.md`, `app/workbench/AGENTS.md` (the Navigator as a sibling of the rail), `packages/claxedo-app/src/ARCHITECTURE.md` (one paragraph under `app/`).
  - Done when a reader can find, from the docs alone, where the placement is read, where the Navigator mounts, which state it owns, and what "Navigator" means; no doc cites a deleted file.

## System-Wide Impact

- **Layout guard.** The Navigator is a sibling inside the one shell body; `layout-guard-baseline.json` must not gain an entry.
- **Composer guard.** No new `PromptInput` mount. Floating is a container change.
- **Ownership graph.** `app/workbench/navigator-sidebar` imports `features/*` and `app/workbench/*` (app → features is allowed). `features/session` learns nothing about the Navigator; it receives `presentation` through `PaneCtx`.
- **Classic placement, one intended behavior change.** Maximizing the panel now floats the session instead of hiding it (Decision 6). Everything else in classic placement is byte-identical.
- **Perf.** The floating stack adds one absolutely positioned layer per focused pane; nothing new is mounted. The Navigator mounts one navigator at a time; the panel body mounts fewer nodes. Measure `shell.sidebarMounted` and the panel open motion before and after on the perf harness.
- **Persistence.** `settings.v3` gains one field; `claxedo.state.v5` gains one slice. No version bumps.
- **Follow-up debt, not in scope.** `chromeGridDefinition` / `chromeRegionPlacement` / `sessionMode` remain unused; the duplicated rail hot-zone logic remains; `WorkspacePanelMode`'s three dead values and `openGlobal` / `toggleGlobal` remain.

## Alternative Approaches Considered

- **Drive the whole shell from `chromeGridDefinition`.** Correct long-term, wrong for this feature: it forces a rewrite of the motion DOM writer, the breakpoint overrides and the absolute panel before any user-visible value ships.
- **A second `PromptInput` mounted over the panel.** Two prompt stores, two focus targets, two dock trees, and a guard violation.
- **Key floating presentation to the placement instead of to full view.** Leaves the classic maximize hiding the composer and needs a second rule for "restore in sidebar placement". Rejected for one rule.
- **Reuse `boundColdFinalTurn` for last-turn-only.** It expands on the first wheel event; coupling a product affordance to it would silently undo itself.

## Success Metrics

- Sidebar placement: the Navigator renders within one frame of the setting change, with no surface remount (pane element identity preserved) and no rail DOM change.
- Panel at full view: the session pane's width is unchanged and the composer is focusable while the panel is open.
- Last-turn reveal: one click renders the full history with the last turn's scroll offset preserved (asserted in e2e).
- Zero changes to classic-placement assertions in `core-sidebar-tree.spec.ts`, `workspace-panel.vitest.tsx` and `rail-sidebar-disclosure.vitest.tsx`.

## Dependencies / Prerequisites

- A committed working tree before any agent starts (see Execution).
- The signed local web e2e harness and the seeded workspace fixtures used by `core-sidebar-tree.spec.ts`.
- The perf harness for the before / after motion measurement.

## Risk Analysis & Mitigation

- **The imperative motion path disagrees with the reactive path** on the column margin. Mitigation: one `workbenchColumnMargin(config)` function feeds both, each with a test.
- **`ProcessPaneProvider` double-subscribes** when the Navigator and the panel both mount one. Mitigation: Unit 0 decides before Unit 4 starts; the one-provider test is extended.
- **i18n parity breaks on the first key.** Mitigation: every key ships in all 17 files in the same commit.
- **A settings mock throws on `appearance.navigatorPlacement`.** Mitigation: Unit 0 inventories every mock; Unit 1 updates them all.
- **The floating stack hides the last turn under the composer.** Mitigation: the stack is a flex column (turn strip above dock); no overlap by construction.

## Phased Delivery

### Phase 1 — Foundations, all parallel
Units 0, 1, 2, 3, 7. None touches another's files. Classic placement is unchanged at the end; the setting exists but selects nothing yet.

### Phase 2 — The placement
Units 4, 5 and 6 in three lanes.

### Phase 3 — Proof and docs
Unit 8, then Unit 9.

## Definition of Done

- [ ] `appearance.navigatorPlacement` exists in `settings.v3` with default `panel`, a localized Settings row in all 17 locales, `setting_changed` telemetry, and the parity baseline still all-empty. Progress:
- [ ] `defaultLayoutConfig({ preset: "claxedo.default" })` is byte-identical to today's config, and `"claxedo.navigator-sidebar"` is fully described by config with an `navigator` region and a percent-100 panel base. Progress:
- [ ] `claxedo.state.v5` persists `navigator: { width, tab }`, validated, with defaults for old blobs. Progress:
- [ ] The rail's source files and its persisted state are unchanged; `core-sidebar-tree.spec.ts` and `rail-sidebar-disclosure.vitest.tsx` pass with no assertion changes. Progress:
- [ ] `NavigatorSidebar` renders Files / Changes / Processes with semantic icons, binds to the focused pane, and drives the panel through `workspacePanel.retarget` with `navigatorHidden: true`. Progress:
- [ ] In sidebar placement the panel opens at full view with `margin-right: 0px` on both the reactive and the motion path, renders no navigator overlay, offers restore, and after restore sits beside the docked session at px width. Progress:
- [ ] The session pane floats over a full-view panel with the same `PromptInput` node identity across docked → floating → docked, all docks inside the floating stack, and no environment card. Progress:
- [ ] `PreviousMessages` renders `visibleUserMessages().length - turnStart()` and one click reveals the full history with scroll preserved; docked scroll-reveal is unchanged. Progress:
- [ ] Below `BP_MD` the preset resolves to classic and the mobile drawer and sheet behave as before. Progress:
- [ ] `layout-guard-baseline.json` is unchanged; `composer-mode.guard.test.ts` passes; `bun run test:architecture-ratchets` passes without a baseline edit this change does not explain. Progress:
- [ ] `core-navigator-sidebar.spec.ts` passes locally in CI's container with a recorded browser-use video of the motion and the reveal. Progress:
- [ ] `app/layout/AGENTS.md`, the Navigator's `AGENTS.md`, `app/workbench/AGENTS.md` and `ARCHITECTURE.md` describe the live code; `app/workbench/preferences/` is deleted. Progress:
- [ ] The exact commands run (typecheck, both test runners, ratchets, e2e shard) and their outcomes are recorded. Progress:

## Execution: parallelize with agents and workflows

**Commit the working tree first.** The branch carries uncommitted edits (`web-crypto.ts`, a deleted desktop template). Review and mutation-testing subagents have reverted uncommitted work before, and stashing on a shared worktree has lost work. Commit, then start agents.

**Disjoint file ownership is mandatory.** Unit 0 produces the map; no two concurrent units name the same file. Known contention points: `app-shell-layout.tsx` (Unit 4 only), `rail-workbench-shell.tsx` and `workspace-panel-motion-state.ts` (Unit 5 only), `message-timeline.tsx` (Unit 7 only), the three settings mocks (Unit 1 only). No unit owns `rail-sidebar.tsx` or `rail-sidebar-shell.tsx`.

Recommended shape:

- **Wave A, five agents concurrently.** Unit 0 (read-only map), Unit 1 (preference + i18n + mocks), Unit 2 (layout preset), Unit 3 (state slice), Unit 7 (history window + row). Each agent runs the test files it owns; run the root ratchets once at the end of the wave.
- **Wave B, three agents concurrently.** Unit 4 (Navigator sidebar + shell mount), Unit 5 (panel behavior), Unit 6 (floating session). They share no files after Unit 0's map is honored.
- **Wave C, one agent.** Unit 8 on the signed local harness inside CI's container, then Unit 9.

Verification runs in parallel with implementation where it does not contend: typecheck, the `bun:test` runner, the vitest runner and the ratchets are four independent commands. The two deferred questions (provider hoisting, floating max height) are answered by research agents during Wave A so Wave B does not block on them.

## Sources & References

- [App architecture](../../packages/claxedo-app/src/ARCHITECTURE.md) — ownership roots and dependency direction.
- [Layout layer](../../packages/claxedo-app/src/app/layout/AGENTS.md) — `LayoutConfig` owner and its import bans.
- [`config.ts`](../../packages/claxedo-app/src/app/layout/config.ts), [`commands.ts`](../../packages/claxedo-app/src/app/layout/commands.ts), [`state.ts`](../../packages/claxedo-app/src/app/layout/state.ts) — the model this plan extends.
- [`app-shell-layout.tsx`](../../packages/claxedo-app/src/app/app-shell-layout.tsx) — the one shell body.
- [`workspace-panel-state.ts`](../../packages/claxedo-app/src/features/workspaces/ui/panel/workspace-panel-state.ts) — `WorkspacePanelNavigator`, `navigatorHidden` and the focus payloads the Navigator reuses.
- [`history-window.ts`](../../packages/claxedo-app/src/features/session/ui/history-window.ts) — the turn window the reveal row drives.
- [`layout.guard.test.ts`](../../packages/claxedo-app/src/architecture/layout.guard.test.ts), [`composer-mode.guard.test.ts`](../../packages/claxedo-app/src/architecture/composer-mode.guard.test.ts) — the two guards this plan must keep green.
