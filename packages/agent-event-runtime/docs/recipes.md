# Recipes

Recipes show the preferred import style. Use root imports for canonical
contracts and harness-agnostic runtime primitives. Use subpaths for harness
adapters and projections.

## Translate One Raw Event

```ts
import {
  createAgentEventRuntime,
  type RawHarnessEvent,
} from "@claxedo/agent-event-runtime"
import { claudeSdkAdapter } from "@claxedo/agent-event-runtime/harnesses/claude"

const runtime = createAgentEventRuntime({
  harness: "claude-sdk",
  threadId: "thread_123",
  adapter: claudeSdkAdapter(),
})

const raw: RawHarnessEvent = {
  source: "claude-sdk",
  payload: { type: "result", subtype: "success" },
}

const result = runtime.ingest(raw)

for (const event of result.events) {
  console.log(event.type)
}
```

## Use A Projection

```ts
import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { claudeSdkAdapter } from "@claxedo/agent-event-runtime/harnesses/claude"
import { createOpencodeCompatProjection } from "@claxedo/agent-event-runtime/projections/opencode-compat"

const runtime = createAgentEventRuntime({
  harness: "claude-sdk",
  threadId: "thread_123",
  adapter: claudeSdkAdapter(),
})

const projection = createOpencodeCompatProjection({
  sessionId: "thread_123",
  directory: "/workspace",
  assistantMessageId: "assistant_123",
})

const translated = runtime.ingest({
  source: "claude-sdk",
  payload: { type: "result", subtype: "success" },
})

const compatEvents = translated.events.flatMap((event) => projection.ingest(event))
```

`opencode-compat` is a compatibility projection. It exists for hosts that need
an OpenCode-shaped event stream; it is not the canonical runtime event model.

## Create A Debug Trace

```ts
import { createDebugTraceProjection } from "@claxedo/agent-event-runtime/projections/debug-trace"

const trace = createDebugTraceProjection()

const rows = translated.events.flatMap((event) => trace.ingest(event))
```

`debug-trace` is a diagnostic projection. It emits compact rows containing the
runtime event type, harness/source id, thread id, raw frame, and diagnostics.
Use it to inspect translations, not as a user-facing event model.

## Implement A Harness Event Adapter

```ts
import {
  agentRuntimeEvent,
  type HarnessEventAdapter,
} from "@claxedo/agent-event-runtime"

type State = {
  emittedText: string
}

export function exampleAdapter(): HarnessEventAdapter<State> {
  return {
    name: "example",
    createInitialState: () => ({ emittedText: "" }),
    translate(input) {
      if (input.event.method === "text") {
        const text = String(input.event.payload)
        return {
          state: { emittedText: input.state.emittedText + text },
          events: [agentRuntimeEvent.textDelta({ delta: text })],
        }
      }

      return []
    },
  }
}
```

## Snapshot And Restore

```ts
import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { claudeSdkAdapter } from "@claxedo/agent-event-runtime/harnesses/claude"

const first = createAgentEventRuntime({
  harness: "claude-sdk",
  threadId: "thread_123",
  adapter: claudeSdkAdapter(),
})

const snapshot = first.snapshot()

const restored = createAgentEventRuntime({
  harness: "claude-sdk",
  threadId: "thread_123",
  adapter: claudeSdkAdapter(),
  initialSnapshot: snapshot,
})
```
