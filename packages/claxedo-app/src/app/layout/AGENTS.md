# Layout Layer

Owns `LayoutConfig`, the built-in regions (`rail`, `workspacePanel`, `workbench`), layout persistence and migration, the layout command set, the chrome grid primitives (`chromeGridDefinition`, `chromeRegionPlacement`), and the shell layout state the app shell drives.
It does not write query cache state and does not import feature components; the shell (`app/app-shell-layout.tsx`) mounts the regions.

## Regions

`defaultLayoutConfig({ target })` is the only place the region set is described: `rail` (left, 260px, order 0), `workbench` (center, 1fr), `workspacePanel` (right, `{ px: 520 }`, hidden until opened). `presetId` is always `"claxedo.default"`.

## Shell layout state

`createShellLayoutState({ target, initialRail, initialWorkspacePanel })` builds `config()` by reducing three command slots (`rail`, `workspacePanelVisibility`, `workspacePanelSize`) over `baseConfig()`, which calls `layoutConfigFromLiveChromeState`.

`workspacePanelFullWidthCommand(config, restoreWidth)` flips the panel between `{ percent: 100 }` and `{ px: restoreWidth }`. The base is a px width, so the `workspacePanelSize` slot holds the full-view command or nothing; the shell clears it when the panel closes.

```json
{
  "owns": "LayoutConfig, builtin regions (rail, workspacePanel, workbench), layout migration, layout commands, shell layout state, chrome grid primitives",
  "writerOf": [],
  "mustNotImport": ["@opencode-ai/sdk*", "@tanstack/*", "@/components/*", "../data/*"]
}
```
