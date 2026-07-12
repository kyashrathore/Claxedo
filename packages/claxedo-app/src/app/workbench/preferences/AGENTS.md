# Pane Layer

Pane-scoped persisted preferences (`store/pane-preferences.ts`). Small,
data-only: the workbench/rail chrome that renders panes lives in `claxedo-ui/`.

```json
{
  "owns": "Pane-scoped persisted preferences",
  "writerOf": [],
  "mustNotImport": ["@opencode-ai/ui/*", "@/components/*", "../../components/*", "@/pages/*", "../../pages/*"]
}
```
