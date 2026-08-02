# Processes Feature

Relay-backed process management, process schemas, diagnostics, ownership
state, and workbench process surfaces form one vertical feature.

```json
{
  "owns": "Process management data, diagnostics, UI, and workbench surfaces",
  "writerOf": [],
  "mustNotImport": ["@/features/browser/*", "@/features/extensions/*", "@/features/session/*", "@/features/terminal/*", "@/app/*"]
}
```
