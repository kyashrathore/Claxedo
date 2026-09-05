# Performance Layer

Owns renderer-phase tracing consumed by the perf harness. Pure timing wrappers
around `performance.now()` and harness-owned window globals; it must stay free
of UI, transport, SDK, and Solid runtime decisions so any module can measure a
phase without widening its own import graph.

`session-perf.ts` also owns the always-on session-open and request diagnostic
recorder. Keep its event and open retention bounded, including incomplete opens.
An open owns its uniquely named User Timing entries; eviction and `clear()` must
release them without clearing other recorders' entries. Callers own session
starts; recording a phase must not synthesize a missing start. Runtime requests
use the recorder's span API so the console request filter reads the same records.

```json
{
  "owns": "renderer-phase measurement wrappers and bounded session diagnostics",
  "writerOf": [],
  "mustNotImport": ["solid-js", "@tanstack/*", "@opencode-ai/sdk*", "@/components/*", "@/features/*", "@/app/*"]
}
```
