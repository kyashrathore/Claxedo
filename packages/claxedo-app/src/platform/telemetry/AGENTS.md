# Telemetry Capability

Headless product telemetry adapters and event capture. Feature and app code may
emit named events through this capability; telemetry does not import product
state or UI.

```json
{
  "owns": "Headless telemetry initialization and event capture",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/*", "@/shell/*", "@/context/*", "@/components/*", "@/claxedo-ui/*", "@/ui/*"]
}
```
