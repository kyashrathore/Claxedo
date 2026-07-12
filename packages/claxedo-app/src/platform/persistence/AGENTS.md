# Persistence Capability

Shared storage keys, serialization adapters, and persisted-state lifecycle used
across app and feature owners. Domain projection shapes stay with their owner;
this capability owns storage mechanics and cross-domain key classification.

```json
{
  "owns": "Shared storage keys, serialization, and persisted-state lifecycle",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/*", "@/shell/*", "@/context/*", "@/components/*", "@/claxedo-ui/*", "@/ui/*"]
}
```
