# Performance Layer

Owns renderer-phase tracing consumed by the perf harness. Pure timing wrappers
around `performance.now()` and harness-owned window globals; it must stay free
of UI, transport, SDK, and Solid runtime decisions so any module can measure a
phase without widening its own import graph.

```json
{
  "owns": "renderer-phase measurement wrappers read wholesale by the perf harness",
  "writerOf": [],
  "mustNotImport": ["solid-js", "@tanstack/*", "@opencode-ai/sdk*", "@/components/*", "@/features/*", "@/app/*"]
}
```
