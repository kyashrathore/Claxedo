# Workbench

Owns: the split-pane layout of the center region, the contents shown in its panes, their persistence, drag-and-drop between panes, and the keyboard chords.

## Concepts

- **Content**: one open thing, identified by `contentId = <kind>:<encoded state>`, so the same session opened twice is one content. Opening matches a saved content by its re-encoded state too, so a content saved under an older encoding (a draft once carried a `draftId`) is the one that gets focused, not a second tab. A `singleton` kind has one content, `contentId = <kind>`: opening it again replaces that content's state and focuses it. Its `PaneKind` (from the shell's `paneKinds` registry) draws it, titles it, and encodes and decodes its state.
- **Pane**: a leaf of the split tree that holds one content or nothing.
- **Layout** (`WorkbenchState`, kept from the old app): panes, the split tree, the alive content ids, their recency, the focused pane, and per-content layout snapshots that `navigation.show` restores when a content that was part of a split is shown again.
- **Handover** (`view/handover.ts`): when a pane changes content, it keeps showing the outgoing content, inert and with a thin progress line that appears after 150 ms, while the incoming one mounts laid out but invisible; the pane swaps them in one frame once the incoming content is revealed. A content is revealed when its view has mounted and every reveal hold its view registered through `holdPaneReveal(pending)` is released (`view/reveal-holds.ts`); a kind that registers none swaps in the same task. The handover is a machine (`settled`, `handing(pane, outgoing, incoming)`), fed by the panes' assignments and by the incoming content's reveal; going back to the outgoing content, emptying the pane, closing the outgoing content or moving it to another pane ends it. Only the outgoing and incoming contents are mounted for the handover; hidden contents still unmount (below).
- **Retention**: up to `MAX_MOUNTED_CONTENTS` (8) slots stay in the DOM, chosen by recency. A hidden slot is `content-visibility: hidden` and `inert`, and its view is unmounted: keeping a visited session mounted saved 8.5 ms per return and cost about 1.5 MiB of heap and 85 nodes per session, so the view remounts from its stores and snapshots. A kind that keeps its state in the DOM sets `keepMounted` (the terminal, whose xterm scrollback and attach live there), and its view stays mounted while hidden.

## One owner

`createWorkbenchStore(key, kinds)` in `store.ts` is the only writer; `layout-api.ts` holds its layout operations and selectors. It keeps one persisted record, `{ layout, contents }`, under the user-scoped key the shell passes, validates it on read (`validate.ts`), and drops any content whose record is missing. Every change goes through the pure reducers in `reducers/` and `apply`, which short-circuits identity-equal results and lets chained calls in one task see each other's writes.

The store also hosts the drag controller (`drag/pointer-drag.ts`) so every drag source and drop zone shares one pointer stream and one ghost, without module-level state.

The panes, the slots and the chrome render in three `display: contents` layers of the root, so replacing a pane's element never moves a slot: a moved element loses its descendants' scroll positions, and the outgoing content of a handover is on screen.

## Opening and closing panes

`useWorkbench()` gives `openPane(kind, state)` and `replacePane(paneId, kind, state)` to open a content, `closePane(paneId)` and `closeContent(contentId)` to close it, `move(tabId, index)` to put a tab at a position in the tab order (a tab id is its content id; the index is clamped to the strip), and `panes()` and `activePane()` to read what is shown.

`onClosed(kind, listener)` calls the listener with the decoded state whenever a content of that kind leaves the workbench for good: its tab is closed, or it is replaced in its pane. Hiding a tab, closing a pane with `mod+w` (the content stays a tab) and dropping a hidden content from retention do not count. A domain whose content holds a server resource subscribes in its provider and releases the resource there, because a `PaneKind` is a static object and cannot reach a provider's stores.

## Routes

A pane kind that can be addressed by URL implements `fromRoute` and `toRoute` on `PaneKind` (`src/shell/types.ts`). The shell calls `openRoute(paneRoute)` when the URL names a draft, session or terminal, and `routeOf(contentId)` when the focused pane changes, to mirror it into the URL.

## Phone

Below 768 px of workbench width the layout projects to one full-bleed pane (`collapse-projection.ts`); the split tree is kept. The pane chrome and the divider hide by the `workbench` container query in `workbench.css`, so a resize writes nothing to the DOM; the width is measured in script only while the layout is split, because only a split has pane rects to project.

## Keyboard

`mod+w` closes the focused pane (content stays as a tab), `mod+\` and `mod+shift+\` split the most recently hidden content beside the focused pane, and `mod+alt+arrows` move focus. Keys with no focused element are forwarded to the focused pane's content through `usePaneContext().onKeyDown`.

## Flows

Flow 12 (split, drag, palette) and flow 33 (phone).
