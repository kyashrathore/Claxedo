# Workbench

Owns: the split-pane layout of the center region, the contents shown in its panes, their persistence, tabs, drag-and-drop between panes, the keyboard chords, and the phone pane switcher.

## Concepts

- **Content**: one open thing, identified by `contentId = <kind>:<encoded state>`, so the same session opened twice is one content. Its `PaneKind` (from the shell's `paneKinds` registry) draws it, titles it, and encodes and decodes its state.
- **Pane**: a leaf of the split tree that holds one content or nothing.
- **Layout** (`WorkbenchState`, kept from the old app): panes, the split tree, the alive content ids, their recency, the focused pane, and per-content layout snapshots that `navigation.show` restores when a content that was part of a split is shown again.
- **Retention**: hidden contents stay mounted, up to `MAX_MOUNTED_CONTENTS` (8), chosen by recency. A hidden slot is `content-visibility: hidden` and `inert`, so it costs no layout and is invisible to the accessibility tree.

## One owner

`createWorkbenchStore(key, kinds)` in `store.ts` is the only writer. It keeps one persisted record, `{ layout, contents }`, under the user-scoped key the shell passes, validates it on read (`validate.ts`), and drops any content whose record is missing. Every change goes through the pure reducers in `reducers/` and `apply`, which short-circuits identity-equal results and lets chained calls in one task see each other's writes.

The store also hosts the drag controller (`drag/pointer-drag.ts`) so every drag source and drop zone shares one pointer stream and one ghost, without module-level state.

## Routes

A pane kind that can be addressed by URL implements `fromRoute` and `toRoute` on `PaneKind` (`src/shell/types.ts`). The shell calls `openRoute(paneRoute)` when the URL names a session or terminal, and `routeOf(contentId)` when the focused pane changes, to mirror it into the URL.

## Phone

Below 768 px of workbench width the layout projects to one full-bleed pane (`collapse-projection.ts`); the split tree is kept. The shell's top bar shows `WorkbenchPaneSwitcher` instead of the tab strip and the pane chrome.

## Keyboard

`mod+w` closes the focused pane (content stays as a tab), `mod+\` and `mod+shift+\` split the most recently hidden content beside the focused pane, and `mod+alt+arrows` move focus. Keys with no focused element are forwarded to the focused pane's content through `usePaneContext().onKeyDown`.

## Flows

Flow 12 (split, tabs, drag, palette, page tab) and flow 33 (phone).
