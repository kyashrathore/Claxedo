# Claxedo Surface/Pane Refactor Handoff

## Purpose

This document is a handoff prompt for continuing the Claxedo layout refactor without relying on the long conversation that led here.

The work is in `/Users/yashvardhansingh/test/opencode`, mostly under `packages/claxedo-app/src/claxedo-ui` and `packages/claxedo-app/src/overrides/pages/session.tsx`.

The product direction is to replace the old tab/group mental model with:

- sidebar as the inventory for sessions and terminals
- canvas as the spatial work area for side-by-side panes
- workspace panel as the right-side contextual surface for review, files, processes, and related workspace actions
- compact top switcher only when the sidebar is collapsed

No backward compatibility is required for this product UX. Prefer deleting or renaming old concepts over preserving confusing compatibility layers, as long as behavior remains correct.

## Product Thesis

Tabs were doing too many jobs:

- switching between sessions
- managing workspace-bound tools like review/diff/file/process views
- acting as a spatial layout system through tab groups and panes
- implying ownership of things that are actually workspace-scoped or focused-session-scoped

The target model is:

- **Sidebar inventory:** sessions and terminals live here. Section headers own creation controls. Items show status and can be closed/disposed where appropriate.
- **Canvas:** only side-by-side / stacked work needs to appear here. Dragging a session or terminal onto the canvas creates a split. The focused pane decides the active work context.
- **Workspace panel:** review, file tree, changed files, processes, and eventually browser/tasks belong here. It is scoped by the focused pane/session/workspace.
- **Collapsed sidebar switcher:** when the sidebar is hidden, a compact top row can expose recent surfaces per workspace. This is a convenience, not the primary model.

Avoid rebuilding a generic tab system under new names. If a UI area really has tabs, keep it local and explicit, such as "workspace panel sections"; do not leak that vocabulary into the canvas model.

## Current State

Major old render owners have been removed:

- `components/group-content-renderer.tsx`
- `components/group-layout-provider.tsx`
- `layouts/top-tab-bar.tsx`
- old tab content files such as `tab-file.tsx`, `tab-review.tsx`, and `tab-portal.tsx`
- old `context/claxedo-layout/tab-actions.ts`
- old `context/group-id.tsx`

The visible runtime path now goes through:

- `layouts/rail-layout.tsx`
- `workspace/WorkspaceShell.tsx`
- `components/surface-content-renderer.tsx`
- `components/multi-pane/surface-pane-content.tsx`
- `components/multi-pane/generic-flat-pane-renderer.tsx`
- `components/multi-pane/generic-leaf-node.tsx`
- `workspace-panel/WorkspacePanel.tsx`
- `components/review-workspace.tsx`
- `layouts/rail-sidebar.tsx`

The refactor is not finished. Many internal names still say `tab`, `group`, or `groupActiveTab`, even where the concept is now a surface or pane.

## Known Current Bugs / Fragile Areas

### Split canvas sizing and close behavior

Recent user-observed bugs:

- Closing a split pane can leave empty space.
- Resizers can be hard to grab or fail to resize.
- Dragging a session/terminal onto the canvas can fail to split.
- Dropping can sometimes make the canvas blank.
- Some fixes that force `width: 100%` make single-session layout ugly because the unsplit session should remain centered.

Important distinction:

- Single unsplit session should keep the centered chat layout.
- Split panes need their canvas containers to have real `width` and `height`.
- Do not fix split sizing by making all session content full-width globally.

The relevant code is:

- `context/claxedo-layout/split.ts`
- `layouts/rail-layout.tsx`
- `components/surface-content-renderer.tsx`
- `components/multi-pane/surface-pane-content.tsx`
- `components/multi-pane/generic-flat-pane-renderer.tsx`
- `components/multi-pane/generic-leaf-node.tsx`
- `overrides/pages/session.tsx`

### Drag/drop targeting

Dragging from the sidebar should support sessions and terminals. It should show a projected drop area for left/right/top/bottom. Dropping onto the bottom of the left pane in a two-column layout should stack only inside that left branch, not restack all panes globally.

Dropping should never route to the session composer file drop zone. The canvas drop handler should win for surface drag payloads.

### Focus and surface selection

Selecting a session or terminal from the sidebar should:

- open it as a new single-pane canvas if it is not part of an existing split layout
- restore the existing split layout if that selected session belongs to a split layout
- not merely replace the focused pane's content

Only the focused pane should determine the active work context.

### Context usage button

Clicking the context usage button in the session header should open context usage in the workspace panel and navigate to it. It should not replace the session surface.

### Workspace panel

Workspace panel direction:

- default section is review/workspace review
- file tree and process list should be right-side navigators beside the review workspace
- clicking a file or process in those navigators should open an item inside the review workspace area
- process navigator should show crashed status, including a red indicator when any process has crashed
- process list should be similar to file tree: list first, individual process opens in workspace panel content

Do not invent browser/tasks content until the old-code mapping is clear. The only concrete old-code mapping so far is processes.

## Immediate Cleanup Still Needed

### 1. Remove temporary debug logs

There are many debug logs with:

- `[claxedo:canvas]`
- `[claxedo:canvas:flood]`
- `[session-page]`

Known files:

- `overrides/pages/session.tsx`
- `components/surface-content-renderer.tsx`
- `components/multi-pane/surface-pane-content.tsx`
- `components/multi-pane/generic-flat-pane-renderer.tsx`
- `components/multi-pane/generic-leaf-node.tsx`

Remove these after the split canvas is stable. Keep only intentional product diagnostics behind the existing debug logger pattern.

### 2. Rename remaining old model names

The biggest remaining mismatch is that pane state still stores surfaces under a field named `tabs`.

Main targets:

- `context/claxedo-layout/types.ts`
  - `SplitPaneState.tabs` should become something like `surfaces`.
- `context/claxedo-layout/pane-accessors.ts`
  - local variables and setters still say `tabs`.
- `context/claxedo-layout/selectors.ts`
  - `groupActiveTab` should become `paneActiveSurface` or `activeSurfaceForPane`.
- `context/claxedo-layout/split.ts`
  - much of the split logic still talks about `group.tabs`.
- `ClaxedoLayout.tsx`
  - comments and locals still say `activeTab`, `tab`, and "focused group's active tab".
- `layouts/rail-layout.tsx`
  - command IDs still include `claxedo.tab.*`.

Target vocabulary:

- surface: a top-level canvas item such as session, terminal, page, workgraph
- pane: a canvas cell in the split tree
- split: the spatial layout tree
- workspace panel: the contextual right panel

Avoid using `group`, `tab`, or `topTabs` for new code unless the code is clearly adapting an upstream API that still uses those words.

### 3. Route/state simplification

The current layout still syncs active surface state into the URL through `ClaxedoLayout.tsx`, `route-intent.ts`, and `surface-route.ts`.

The desired direction is likely:

- URL identifies workspace/session/page enough for reload/deep-link.
- Active canvas selection is state, not the source of truth for every route transition.
- No fallback behavior that silently recreates fake tabs/surfaces.

Before editing this area, write down the invariant and add tests. Route bugs easily create phantom sessions/surfaces.

### 4. Session-local file/review tabs

`overrides/pages/session.tsx` still has upstream/session-local tab code:

- `layout.tabs(...)`
- `FileTabContent`
- context/review/file local active tab handling
- file tab drag/drop code

Decide whether these are still needed. The likely target is:

- review/file/context moves to workspace panel
- session page becomes mostly chat transcript + prompt + session header controls
- comments from review/file/browser/process context bind to the focused session, including terminal-backed agent sessions where applicable

### 5. Workspace panel naming

`components/review-workspace.tsx` still uses local tabs for review/context/open files/open processes. This may remain as local workspace-panel section state, but the names should make it clear this is not the main canvas tab model.

Possible names:

- workspace panel section
- workspace panel item
- review workspace item
- open workspace document

### 6. Test names and assertions

Many tests still document old concepts, for example:

- `tab-empty-state.test.ts`
- `process-tab-close.test.ts`
- `session-select-tab.test.ts`
- `workspace-bar.test.ts`
- old comments saying "tabs" where the expected behavior is surfaces

Rename tests only after behavior is stable. Test names should teach the new model.

## Suggested Execution Order

1. Stabilize split canvas behavior.
2. Add regression tests for split/drop/close/resize.
3. Remove temporary debug logs.
4. Rename internal `group.tabs` state to `pane.surfaces`.
5. Rename selectors/actions/commands from tab/group to surface/pane.
6. Simplify route synchronization.
7. Move remaining session-local file/review/context tab behavior into workspace panel or rename it as local workspace-panel state.
8. Rename tests and remove dead files.
9. Run focused tests, then full claxedo-app typecheck.

## Verification Commands

Run from `packages/claxedo-app`, not repo root:

```sh
bun test src/claxedo-ui/context/claxedo-layout.contract-ops.test.ts
bun run test:ui -- src/claxedo-ui/layouts/rail-layout.vitest.tsx
bun typecheck
git diff --check
```

Add or update focused tests around any bug fixed. Do not rely only on manual browser checking for split behavior.

## Detailed Agent Prompt

Use this prompt for the next agent:

```text
You are continuing the Claxedo layout refactor in /Users/yashvardhansingh/test/opencode.

Read AGENTS.md first. Work mainly in packages/claxedo-app. Do not run tests from repo root; run from packages/claxedo-app. Use rg for search and apply_patch for edits. Do not reset or revert unrelated changes. This is a dirty worktree with many intentional in-progress changes.

Product goal:
Move from old tabs/groups/tab-groups to a cleaner model:
- sidebar is the inventory for sessions and terminals
- canvas is spatial work: panes and splits only
- workspace panel owns review/files/processes/contextual workspace tools
- compact top switcher exists only for collapsed sidebar convenience

No backward compatibility is required for this UX. Prefer finishing the refactor cleanly instead of preserving old tab/group vocabulary.

Current visible render path:
- packages/claxedo-app/src/claxedo-ui/layouts/rail-layout.tsx
- packages/claxedo-app/src/claxedo-ui/workspace/WorkspaceShell.tsx
- packages/claxedo-app/src/claxedo-ui/components/surface-content-renderer.tsx
- packages/claxedo-app/src/claxedo-ui/components/multi-pane/surface-pane-content.tsx
- packages/claxedo-app/src/claxedo-ui/components/multi-pane/generic-flat-pane-renderer.tsx
- packages/claxedo-app/src/claxedo-ui/components/multi-pane/generic-leaf-node.tsx
- packages/claxedo-app/src/claxedo-ui/workspace-panel/WorkspacePanel.tsx
- packages/claxedo-app/src/claxedo-ui/layouts/rail-sidebar.tsx

Immediate task:
First stabilize the split canvas. The user recently saw:
- closing a pane leaves empty blank columns
- resizer is not properly grabable and sometimes does not resize
- dragging/dropping a session or terminal can fail to create the expected split
- dropping bottom of the left pane in a left/right split should stack only inside the left branch, not restack every pane
- dropping surface payloads should not go to the session composer file drop zone
- forcing all session content to width 100% is wrong because single unsplit sessions should remain centered

Root-cause these in the split/canvas code. Do not add fake fallback rendering. Do not hide broken state with placeholders. Fix the actual split tree, sizing, and event ownership.

Key files for split/canvas:
- context/claxedo-layout/split.ts
- layouts/rail-layout.tsx
- components/surface-content-renderer.tsx
- components/multi-pane/surface-pane-content.tsx
- components/multi-pane/generic-flat-pane-renderer.tsx
- components/multi-pane/generic-leaf-node.tsx
- overrides/pages/session.tsx

Expected invariants:
- each split pane id is unique
- the split root tree and visible pane list agree
- closing a pane removes its leaf from the root tree and normalizes sibling sizes
- a branch split preserves the unaffected sibling branch
- a surface drag creates/moves a surface into the intended pane or new split branch
- selecting a new sidebar session opens a new single-pane canvas unless that session already belongs to a saved split layout
- selecting back to a session that owns a split layout restores that layout
- centered chat layout applies only to single visible pane and single visible leaf
- split panes have full width/height within their cell

After fixing behavior:
1. Add regression tests for the bugs.
2. Remove all temporary [claxedo:canvas] and [claxedo:canvas:flood] console logs.
3. Continue the naming cleanup:
   - SplitPaneState.tabs -> surfaces
   - groupActiveTab -> activeSurfaceForPane / paneActiveSurface
   - groupId variables -> paneId
   - claxedo.tab.* commands -> claxedo.surface.* or claxedo.pane.*
   - comments and tests should say surface/pane/split/workspace panel, not tab/group, unless adapting upstream.
4. Then simplify route/surface coupling and move remaining session-local file/review/context tab state toward the workspace panel.

Before reporting done, run:
- bun test src/claxedo-ui/context/claxedo-layout.contract-ops.test.ts
- bun run test:ui -- src/claxedo-ui/layouts/rail-layout.vitest.tsx
- bun typecheck
- git diff --check

If a test cannot run, say exactly why. Keep the final summary short and focused on files changed, behavior fixed, and verification.
```

## Notes For The Agent

The user is sensitive to mental-model drift. If you use old words like "tab" for a canvas surface, you are likely preserving the wrong abstraction. If a thing is shown side-by-side, call it a pane/surface. If it is a right-side contextual tool, call it a workspace panel item/section. If it is merely a compact collapsed-sidebar switcher, keep it scoped to that UI.

The user also dislikes brittle fallback fixes. If the canvas is blank, do not add a loading placeholder and call it fixed. Find which element lost width/height, which split leaf was orphaned, or which route/state mutation created an impossible surface.

