# Panel

Owns: the workspace panel, v1's right-hand overlay with its own tab strip. Files, the browser and plans open here as panel tabs; the workbench never holds them.

## Owned concepts

- **Frame** (`view/panel-frame.tsx`): `WorkspaceArea` wraps the center column. The panel is an `aside` absolutely positioned at its right, z 30, sliding with a 120 ms transform while the column's `margin-right` animates to the panel's width. On a phone (below 640 px) or when maximized, the panel covers the column and the margin stays 0. The body mounts while the panel is shown and unmounts 140 ms after it closes.
- **Width** (`width.ts`): 70% of the area by default, at least 360 px, at most 86%, always leaving 300 px for the session. A drag or the keyboard (ArrowLeft +24, ArrowRight −24, Home, End) chooses a width, kept in `panel.width`. Dragging suspends terminal refits and emits `claxedo:terminal-fit` when it ends.
- **Working set** (`working-sets.ts`, `tabs-store.ts`): the tabs and the selected tab per placement, in memory only, for up to 32 placements. Review is always first and never closes; its "×" closes the panel. Every other tab is appended in open order, one per file path, one Browser, one Context.
- **Tab model** (`workspace-tabs.ts`, `tab-presentation.ts`, `close.ts`, `view/tab-button.tsx`): v1's tab kinds (review, context, file, browser, subagent, plan), labels, icons and the rule for which tab is selected after a close. Subagent and plan tabs show only for the session that produced them. A context or subagent tab renders the view registered for its kind in the shell's `panelViews` registry, with `{ placementId, sessionId, parentSessionId }`; "+ > Context" shows once a context view is registered.
- **Focus** (`focus.ts`): `PanelFocus` is how a caller opens something: `usePanel().show(focus)` opens the panel and appends or selects the tab. A file focus also records the line and column to reveal, with a version, so a repeated click reveals again.
- **Navigator** (`view/panel-body.tsx`, `view/tool-buttons.tsx`): the column beside the tab content, `min(280px, 45%)` wide: Files (`@/files`) or Changes (`@/review`), toggled by the L2 row's "Open Files" / "Open Changes". The choice persists in `panel.navigator`; each view stays mounted once shown. A Changes row selects the Review tab and reveals that file's diff.
- **Maximized** (`store.tsx`): `usePanel().maximized()` is true while the panel is open at full width, covering the workbench column; the session screen floats its composer over the panel then.
- **Header** (`view/panel-header.tsx`, `view/tab-strip.tsx`, `view/toggle.tsx`): L1 is the tab strip, "+" ("Add workspace tab"), "Maximize workspace panel" and "Close workspace panel". L2 shows the active tab's context: the review toolbar slots, the browser toolbar slot, a file's path with the Markdown source toggle and its actions slot, or a plan's title. `PanelToggle` is the top bar's "Open workspace panel", shown while the panel is closed.

## Invariants

- The shell's layout owns whether the panel is shown (`showPanel`, `hidePanel`, `togglePanel`); this domain owns everything inside it.
- The panel shows the route's placement. A tab's content reads through its own domain: `@/files` for file tabs and the tree, `@/review` for Review, `@/browser` for Browser, `@/transcript` for plans.
- Tabs never persist across a reload; only the navigator and the width do.

## Flows

Flow 11 (a transcript file link opens a panel tab), flow 13 (a terminal link opens the file at the line), flow 14 (Review), flow 27 (the tree opens a file tab) and flow 33 (phone).
