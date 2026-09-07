# Navigator Sidebar

`NavigatorSidebar` is the secondary left column the shell mounts under the `"claxedo.navigator-sidebar"` layout preset (`appearance.navigatorPlacement === "sidebar"`), between the rail and the workbench. It holds the three workspace navigators — Files, Changes, Processes — bound to the workspace of the focused pane (`focusedPanelTarget`), and drives the workspace panel through `claxedoState.workspacePanel.open` with the same focus payloads the in-panel navigators send. Its width and active tab are the `claxedoState.navigator` slice; the live width flows through `createShellLayoutState().navigatorWidth` and commits back to the slice on drag end.

The Processes tab shares its live process pane with the panel body through `context/process-pane-registry` (one instance per workspace directory); it never constructs one of its own.

```json
{
  "owns": "NavigatorSidebar: the sidebar placement's Files / Changes / Processes column bound to the focused pane",
  "writerOf": [],
  "mustNotImport": ["@/app/routes/*", "@/app/workbench/rail/*", "../rail/*", "@tanstack/*"]
}
```
