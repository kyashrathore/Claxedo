# Global WorkGraph Tabs With Global Page Panes

## Summary

WorkGraph is now a first-class global page tab. It no longer relies on a fake `__pages__` directory sentinel. Global behavior is explicit at the tab layer, and page panes can also exist without a directory while directory-backed pane types remain strict.

## Implementation

- `TabItem` now supports `directory?: string` and an explicit `scope?: "directory" | "global"`.
- `PaneContent` is now split so `page`, `pages-index`, and `workgraph` panes may omit `directory`.
- Shared helpers were added in the layout types layer:
  - `isGlobalTab()`
  - `isGlobalPane()`
  - `realDirectory()`
  - `tabScopeDir()`
- `addPage()` now creates:
  - a directory-scoped page tab when a directory is provided
  - a global page tab when no directory is provided
- Global tabs are grouped ahead of directory-scoped tabs and always survive workspace pin/scope filtering.
- WorkGraph opens through `addWorkgraph()` with no directory.
- Route sync and tab-context persistence now preserve global page tabs as global instead of rebinding them to the route workspace.
- Page panes without a directory render normally, while directory-backed pane types still require a resolved directory before creation.

## Verification

- `bun typecheck`
- `bun test src/claxedo-ui/context/claxedo-layout/tab-actions.test.ts src/claxedo-ui/context/claxedo-layout/route-intent.test.ts src/claxedo-ui/context/tab-url-sync.test.ts src/claxedo-ui/layouts/session-select-tab.test.ts src/claxedo-ui/context/claxedo-layout/tab-context-sync.test.ts`
- `bun test src/claxedo-ui/claxedo-layout-actions/tab-actions-ui.test.ts src/claxedo-ui/context/tab-url-sync.test.ts src/claxedo-ui/context/claxedo-layout.test.ts src/claxedo-ui/layouts/workspace-project-integrity.test.ts`
