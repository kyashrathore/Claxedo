# Process Layer

Headless process-management client and wire schemas: the relay-backed process
client (`client.ts`) and the zod schemas describing process config / launch
results / diagnostics (`process.ts`). No UI, no Solid — process-pane rendering
lives in `features/processes/providers/process-pane.tsx`.

```json
{
  "owns": "Process management client + process wire schemas (config, launch, diagnostics)",
  "writerOf": [],
  "mustNotImport": ["@opencode-ai/ui/*", "@/ui/*"]
}
```
