# Layout Layer

Owns LayoutConfig, layout presets, the built-in regions (rail, navigator, workspace panel, workbench), layout persistence, and shell chrome composition primitives.
It should not write query cache state or import feature components directly.

`defaultLayoutConfig({ preset })` is the only place a preset's region set is described. Under `"claxedo.navigator-sidebar"` the `navigator` region sits on the left at order 1 and the workspace panel's base size is `{ percent: 100 }`, so the `workspacePanelSize` command slot inverts its meaning: an empty slot is full view, and the latched `workspacePanelFullWidthCommand` is the *restore* to a px width. Closing the panel clears the slot, so the next open is full again.

```json
{
  "owns": "LayoutConfig, layout presets, builtin regions (rail, navigator, workspacePanel, workbench), layout provider, chrome shell primitives",
  "writerOf": [],
  "mustNotImport": ["@opencode-ai/sdk*", "@tanstack/*", "@/components/*", "../data/*"]
}
```
