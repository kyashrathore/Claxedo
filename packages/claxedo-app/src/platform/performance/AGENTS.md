# Performance Capability

Shared performance instrumentation, renderer measurements, and diagnostic
subtraction contracts. Production features may report measurements here, but
this capability must not own product behavior or depend on product layers.

```json
{
  "owns": "Cross-feature performance measurement and diagnostic build contracts",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/*", "@/shell/*", "@/context/*", "@/components/*", "@/claxedo-ui/*"]
}
```
