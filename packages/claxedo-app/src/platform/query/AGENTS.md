# Query Capability

TanStack Query client lifecycle, persistence, shared key contracts, and query
adapters reused across product features. Domain-specific query behavior stays
with its feature unless multiple features share the same independent contract.

```json
{
  "owns": "Query client lifecycle, persistence, shared keys, and cross-feature query adapters",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/*", "@/shell/*", "@/context/*", "@/components/*", "@/claxedo-ui/*"]
}
```
