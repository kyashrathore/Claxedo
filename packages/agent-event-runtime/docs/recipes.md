# Recipes

Import canonical contracts from `@claxedo/agent-runtime-contract`. Use this
package's subpaths for projections. The harness translators that produce these
events are internal to `@claxedo/harness` transports.

## Use A Projection

```ts
import { agentRuntimeEvent } from "@claxedo/agent-event-runtime"
import { createClientPresentationProjection } from "@claxedo/agent-event-runtime/client-presentation"

const projection = createClientPresentationProjection({
  sessionId: "thread_123",
  directory: "/workspace",
  assistantMessageId: "assistant_123",
})

const events = [agentRuntimeEvent.textDelta({ delta: "Hello" })]
const compatEvents = events.flatMap((event) => projection.ingest(event))
```

`client-presentation` is a compatibility projection. It exists for hosts that need
an OpenCode-shaped event stream; it is not the canonical runtime event model.

## Create A Debug Trace

```ts
import { createDebugTraceProjection } from "@claxedo/agent-event-runtime/projections/debug-trace"

const trace = createDebugTraceProjection()

const rows = events.flatMap((event) => trace.ingest(event))
```

`debug-trace` is a diagnostic projection. It emits compact rows containing the
runtime event type, harness/source id, thread id, raw frame, and diagnostics.
Use it to inspect translations, not as a user-facing event model.
