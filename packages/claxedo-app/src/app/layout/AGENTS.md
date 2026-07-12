# Layout Layer

Owns LayoutConfig, layout persistence, and shell chrome composition primitives.
It should not write query cache state or import feature components directly.

```json
{
  "owns": "LayoutConfig, layout provider, chrome shell primitives",
  "writerOf": [],
  "mustNotImport": ["@opencode-ai/sdk*", "@tanstack/*", "@/components/*", "../data/*"]
}
```
