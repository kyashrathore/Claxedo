# Layout Layer

Owns `LayoutConfig`, the layout presets, the built-in regions (`rail`, `navigator`, `workspacePanel`, `workbench`), layout persistence and migration, the layout command set, the chrome grid primitives (`chromeGridDefinition`, `chromeRegionPlacement`), and the shell layout state the app shell drives.
It does not write query cache state and does not import feature components; the shell (`app/app-shell-layout.tsx`) reads the preference and mounts the regions.

## Presets

`LayoutPreset` (`config.ts`) is `"claxedo.default" | "claxedo.navigator-sidebar"`. `defaultLayoutConfig({ target, preset })` is the only place a preset's region set is described:

- `"claxedo.default"`: `rail` (left, 260px, order 0), `workbench` (center, 1fr), `workspacePanel` (right, `{ px: 520 }`, hidden until opened).
- `"claxedo.navigator-sidebar"`: the same three plus `navigator` (left, 320px, order 1, between the rail and the workbench), and the workspace panel's base size is `{ percent: 100 }` instead of a px width.

`normalizeLayoutConfig` re-inserts a missing `navigator` region whenever the requested preset's defaults have one, so a config persisted under one preset migrates cleanly when the preference changes. `layoutConfigFromLiveChromeState` accepts `navigator.width`; under the sidebar preset the flat `workspacePanel.width` is ignored and the panel keeps its percent size.

## The `navigator` region

`navigator` is a left-side, docked, collapsible px region. `navigatorResizeCommand` (`commands.ts`) clamps its width to 260..520; `createShellLayoutState` (`state.ts`) exposes `navigatorWidth()`, `setNavigatorWidth()` and `committedNavigatorWidth()` on top of it. The live width lives in this layer's command slot; the persisted width lives in the workbench state slice `app/workbench/state/navigator.ts` (`claxedoState.navigator`), which the shell writes on drag end.

## Shell layout state

`createShellLayoutState({ target, preset, initialRail, initialWorkspacePanel, initialNavigator })` builds `config()` by reducing four command slots (`rail`, `navigator`, `workspacePanelVisibility`, `workspacePanelSize`) over `baseConfig()`. `baseConfig()` calls `layoutConfigFromLiveChromeState` with `input.preset()`, so `config()` re-derives from the preset accessor: when `app/app-shell-layout.tsx`'s `layoutPreset()` flips (it reads `settings.appearance.navigatorPlacement()` and forces `"claxedo.default"` on a narrow viewport), the region set changes without rebuilding the state.

The `workspacePanelSize` slot latches whatever the preset's base does not express. `workspacePanelFullWidthCommand(config, restoreWidth)` flips the panel between `{ percent: 100 }` and `{ px: restoreWidth }`. Under `"claxedo.default"` the base is a px width, so the latched command is full view. Under `"claxedo.navigator-sidebar"` the base is already full view, so the slot inverts: an empty slot is full view and the latched command is the *restore* to a px width. The shell's `workspacePanelSizeLatches` picks which to keep, and closing the panel clears the slot so the next open is full again.

```json
{
  "owns": "LayoutConfig, layout presets, builtin regions (rail, navigator, workspacePanel, workbench), layout migration, layout commands, shell layout state, chrome grid primitives",
  "writerOf": [],
  "mustNotImport": ["@opencode-ai/sdk*", "@tanstack/*", "@/components/*", "../data/*"]
}
```
