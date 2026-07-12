# Data Layer

Owns shell query keys, projectors, cache lifecycle helpers, and data-facing SDK
adaptation. UI components should not be imported into this layer.

```json
{
  "owns": "Query keys, projectors, cache lifecycle, shell data adapters",
  "writerOf": [],
  "mustNotImport": ["@/components/*", "../components/*", "../../components/*"]
}
```
