# Identity Layer

Owns the session identity vocabulary, shell route parsing, and workspace-ref
resolution. It should stay free of transport, SDK, UI, and Solid runtime
decisions.

```json
{
  "owns": "SessionRef vocabulary, route parse/format, workspace ref resolution",
  "writerOf": [],
  "mustNotImport": ["solid-js", "@tanstack/*", "@opencode-ai/sdk*", "../data/*", "../auth/*", "@/components/*"]
}
```
