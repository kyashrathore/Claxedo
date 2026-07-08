# Agent Event Runtime

`@claxedo/agent-event-runtime` normalizes raw harness events into a canonical
`AgentRuntimeEvent` stream. It also provides projections, including OpenCode
compatibility events.

An agent harness is the agent application/control surface that executes a turn.
This package does not launch harnesses. It translates events emitted by a host,
SDK, ACP client, or native adapter into Claxedo's runtime event contract.

## Mental Model

There are three boundaries:

| Boundary | Purpose |
| --- | --- |
| Harness event adapter | Translates native harness frames into `AgentRuntimeEvent`s. |
| Runtime snapshot | Stores the harness/source id, thread id, snapshot version, and adapter state so translation can resume. |
| Projection snapshot | Stores projection name, snapshot version, and projection state so output views can resume. |

A snapshot is a serializable checkpoint of one of these state boundaries. It
lets a host resume translation or projection without replaying every previous
frame from the beginning.

`RuntimeSnapshot` resumes harness-frame-to-`AgentRuntimeEvent` translation.
`ProjectionSnapshot` resumes `AgentRuntimeEvent`-to-output-view projection.

## ACP Event Translation

```ts
import {
  createAcpEventTranslator,
  createAgentEventRuntime,
} from "@claxedo/agent-event-runtime"

const runtime = createAgentEventRuntime({
  harness: "codex",
  threadId: "session-1",
  adapter: createAcpEventTranslator({ client: "codex" }),
})

const result = runtime.ingest(rawHarnessEvent)

for (const event of result.events) {
  // AgentRuntimeEvent
}
```

## OpenCode Compatibility Projection

```ts
import { createOpencodeCompatProjection } from "@claxedo/agent-event-runtime"

const compat = createOpencodeCompatProjection({
  sessionId: "session-1",
  directory: process.cwd(),
  assistantMessageId: "assistant-1",
})

const opencodeEvents = result.events.flatMap((event) => compat.ingest(event))
```

## Determinism And Restore

`createAgentEventRuntime()` accepts `clock` and `createId` options. All adapter
timestamps and fallback ids are minted through those injected functions. If
omitted, the runtime uses `systemClock` (`Date.now`) and a local sequential id
factory starting at `0`.

`createOpencodeCompatProjection()` accepts its own `clock` option for
compatibility event timestamps such as tool card times and session title update
times. If omitted, this projection uses `Date.now` at the projection boundary.

Runtime snapshots persist adapter state, but they do not persist the default
sequential id factory counter. Callers that restore a runtime and need stable
fallback ids across restore must provide deterministic payload ids or their own
persisted `createId` implementation.

## Exports

The package exports contracts, core runtime helpers, harness adapters, and
projections:

- `contracts`
- `core`
- `harnesses/acp`
- `harnesses/claude`
- `harnesses/codex`
- `projections/debug-trace`
- `projections/opencode-compat`

`debug-trace` is a projection for diagnostics. It produces a compact,
human-readable trace of canonical runtime events so hosts can inspect ordering,
ids, tool lifecycles, and translation behavior.

The canonical event contract exports `AGENT_RUNTIME_EVENT_CONTRACT_VERSION`,
`AGENT_RUNTIME_EVENT_TYPES`, and `agentRuntimeEvent` factories. Use the
factories when constructing new canonical events so event-kind drift is caught
by TypeScript.

Tool lifecycle events can include a harness-neutral `ToolDisplay` payload with
the canonical `ToolIntent` taxonomy. Put projection-critical facts such as
intent, mode, command, paths, query, files, locations, and normalized tool input
in `display`; keep harness-native `metadata` for debugging and provenance.

## Grounding

Implemented in:

- `packages/agent-event-runtime/src/index.ts`
- `packages/agent-event-runtime/src/core/runtime.ts`
- `packages/agent-event-runtime/src/harnesses/acp/event-translator.ts`
- `packages/agent-event-runtime/src/harnesses/claude/adapter.ts`
- `packages/agent-event-runtime/src/harnesses/codex/adapter.ts`
- `packages/agent-event-runtime/src/projections/opencode-compat/projection.ts`
