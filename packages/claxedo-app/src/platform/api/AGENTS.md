# API Capability

Shared base URL resolution, authenticated request runtime, and headless HTTP
adapters used by multiple features. Domain-specific clients remain with their
feature or app connection owner.

```json
{
  "owns": "Shared API runtime, base URL resolution, and headless HTTP adapters",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/*", "@/shell/*", "@/context/*", "@/components/*", "@/claxedo-ui/*", "@/ui/*"]
}
```
