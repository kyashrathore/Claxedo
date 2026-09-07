# Navigator Sidebar

"Navigator" is `WorkspacePanelNavigator = "files" | "changes" | "processes"` (`features/workspaces/ui/panel/workspace-panel-state.ts`): the three workspace-scoped lists that pick what the workspace panel shows. `NavigatorSidebar` is the column that hosts them when `settings.appearance.navigatorPlacement()` (`platform/settings/provider.tsx`, `"panel" | "sidebar"`, default `"panel"`) is `"sidebar"`.

## Where it mounts

`app/app-shell-layout.tsx` derives `layoutPreset()` from the preference and mounts `NavigatorSidebar` (lazily, inside the shell's `<nav>`, after `RailSidebarShell`) while `layoutConfig().regions.navigator?.visible` and `emptyDraft.sidebarEligible()` (a project exists or a surface is open). The region only exists under the `"claxedo.navigator-sidebar"` preset (`app/layout/AGENTS.md`), so the sidebar unmounts when the preference returns to `"panel"` or the viewport is narrow.

## What it owns

- `navigator-sidebar.tsx`: the `<aside data-testid="navigator-sidebar">` column, the resize handle, and `NavigatorWorkspace`, which is keyed on the focused pane's workspace. `target` is `workbenchController.focusedPanelTarget` (a `WorkspacePanelPaneTarget`); without one the column shows the empty message. Files and Changes render `WorkspaceFilesNavigator` (`../workspace-panel/files-navigator.tsx`); Processes renders `ProcessesNavigator` (`../workspace-panel/processes-navigator.tsx`). A navigator stays mounted once visited so its tree state survives tab switches.
- `navigator-sidebar-tabs.tsx`: the `role="tablist"` strip over `NAVIGATOR_SIDEBAR_TABS`.
- `paneSessionScope`: the session identity the column binds to, read the way the workspace panel body reads it (the pane's content, else the focused surface), so `SessionPaneScope` inside the column matches the panel's.

## State it reads and writes

- Width and active tab are the `claxedoState.navigator` slice (`app/workbench/state/navigator.ts`, persisted by `app/workbench/state/persistence.ts`; defaults 320px and `"changes"`). The live width during a drag flows through `createShellLayoutState().navigatorWidth` (`app/layout/state.ts`); the shell commits `committedNavigatorWidth()` to the slice on drag end.
- Selection drives the panel: a file or process click calls `claxedoState.workspacePanel.open("review", { workspaceDir, targetPaneId, navigator, focus })`, the same payloads the in-panel navigators send. The highlighted row comes back from `workspacePanel.state().focus` when that state's `workspaceDir` matches the column's.
- The panel side reacts to the placement, not to this directory: `rail/workspace-panel-body.tsx` skips its in-panel Files/Changes navigator under sidebar placement, and `rail/workspace-panel-visual-state.ts`'s `toggleFocusedWorkspaceNavigator` selects the sidebar tab instead of toggling the panel off.

## One process pane per workspace

The Processes tab mounts `ProcessPaneProvider` from `../context/process-pane.tsx` with `isOpen` = "the Processes tab is selected". That provider binds the shared instance from `../context/process-pane-registry.ts` (one refcounted process pane per `workspaceDir`, `isOpen` = the union of every holder), so the column and the workspace panel body read the same pane through `useWorkspaceProcessPane`. This directory never imports the feature's own `ProcessPaneProvider` from `@/features/processes/providers`; a second feature provider for one directory would double the event subscription, the persisted store, and the pending-action slot.

## Must not import

Rail internals (`../rail/*`), routes, query infrastructure, and the processes feature's providers. It composes workspace-panel navigators and workbench context only.

```json
{
  "owns": "NavigatorSidebar: the sidebar placement's Files / Changes / Processes column bound to the focused pane",
  "writerOf": [],
  "mustNotImport": [
    "@/app/routes/*",
    "@/app/workbench/rail/*",
    "../rail/*",
    "@tanstack/*",
    "@/features/processes/providers*",
    "*/features/processes/providers*"
  ]
}
```
