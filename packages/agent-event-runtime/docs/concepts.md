# Concepts

This page builds the mental model for `@claxedo/agent-event-runtime`.

## The Short Version

External agent harnesses emit different event shapes. A Claude SDK frame, an
ACP `session/update`, a Cursor SDK event, and a Codex app-server notification
do not look the same.

This package gives hosts one common event language:

```text
harness-native event frame
  -> RawHarnessEvent
  -> harness event adapter
  -> AgentRuntimeEvent
  -> RuntimeProjection
```

After translation, host code can consume `AgentRuntimeEvent` without caring
which external harness produced the original frame.

External harness event sources are identified by a `harness` id.
The TypeScript API names a harness event adapter `HarnessEventAdapter`, and harness
adapters live under `src/harnesses`.

## The Four Main Objects

### `RawHarnessEvent`

The outer envelope around one harness-native event frame.

```ts
type RawHarnessEvent = {
  source: string
  method?: string
  payload: unknown
  receivedAt?: number
}
```

It answers: "What harness event frame arrived?"

`payload` is intentionally `unknown`. The harness event adapter owns parsing it.

### `HarnessEventAdapter`

The TypeScript name for a harness event adapter.

It receives:

- the previous adapter state
- one `RawHarnessEvent`
- deterministic context such as `harness`, `threadId`, `now`, and `createId`

Here `harness` is the current API field for the external harness/source id.

It returns:

- zero or more `AgentRuntimeEvent` values
- optional updated adapter state
- optional diagnostics

It answers: "How does this harness event frame map to the canonical event model?"

### `AgentRuntimeEvent`

The canonical event language.

Examples of event kinds:

- `text-delta`
- `thinking-delta`
- `tool-start`
- `tool-status`
- `tool-output`
- `file-diff`
- `permission-request`
- `question`
- `todo-update`
- `session-status`
- `diagnostic`

It answers: "What happened in harness-neutral terms?"

Hosts should store, replay, inspect, and project this shape instead of treating
harness-native frames as their main application model.

### `RuntimeProjection`

A projection converts canonical runtime events into an output view.

Examples:

- `opencode-compat` turns canonical events into OpenCode-compatible envelopes.
- `debug-trace` turns canonical events into compact diagnostic rows.
- a host can write its own projection into app database rows.

It answers: "What view does my host need from the canonical event stream?"

## Event Lifecycle

```text
1. External harness emits a native event frame
   Example: Claude SDK message, ACP session/update, Cursor SDK event.

2. Host wraps it as RawHarnessEvent
   The host preserves source/method/payload.

3. Harness event adapter translates it
   In TypeScript this adapter implements `HarnessEventAdapter`. It parses payload
   and emits canonical `AgentRuntimeEvent` values.

4. Runtime stamps metadata
   The runtime attaches external harness/source id, threadId, and raw frame
   metadata.

5. Projection derives host views
   A projection emits OpenCode compat events, debug traces, UI rows, or another
   host-specific view.
```

The adapter does not decide where events are stored or who can read them. The
projection does not start harness processes. The host wires those pieces
together.

## Runtime State Vs Projection State

There are two state boundaries.

Runtime state belongs to the harness event adapter. It helps translate the next
raw frame correctly. For example, an adapter may remember partial tool input or
previous text content.

Projection state belongs to one output view. It helps produce incremental
output. For example, the OpenCode compatibility projection tracks message parts
and tool part ids.

Keep these separate:

```text
Harness event adapter state
  helps translate harness event frames

RuntimeProjection state
  helps emit an output view
```

A snapshot is saved state for resuming work. It lets a host continue
translation or projection without replaying every previous frame from the
beginning.

`RuntimeSnapshot` saves the harness event adapter's memory, so it can keep
translating new harness frames into `AgentRuntimeEvent` values after a restart.

For example, a harness may stream tool input in chunks:

```text
frame 1: tool call started
frame 2: partial input: {"file":
frame 3: partial input: "README.md"}
frame 4: tool call completed
```

The harness event adapter may need to remember frames 1-3 to translate frame 4
correctly. With a `RuntimeSnapshot`, the host can restore that adapter memory
and continue from frame 4 instead of replaying the whole sequence.

`ProjectionSnapshot` saves a projection's memory, so it can keep turning
`AgentRuntimeEvent` values into the same output view after a restart.

For example, the OpenCode compatibility projection may remember:

```text
toolCallId abc -> message part id part_7
assistant text so far -> "hello wor"
open tools -> [abc]
```

When the next canonical event arrives:

```text
{ type: "text-delta", delta: "ld" }
```

the projection needs its previous state to output the correct updated OpenCode
message part.

Do not put host database state, auth state, process handles, or HTTP connection
state in either snapshot.

## Diagnostics

Diagnostics are part of the model, not an afterthought.

Harness event adapters should emit diagnostics when:

- a harness event frame is unknown
- a mapping is lossy
- a harness field is malformed
- a frame is valid but not useful to projections

The runtime also catches adapter exceptions and converts them into diagnostic
events. A bad harness event frame should not crash the host stream.

## Determinism

The runtime accepts injected `clock` and `createId` functions.

Use them in tests and replay tools so the same raw frame history produces the
same canonical event history.

Harness event adapters should use the context functions instead of calling
`Date.now()` or random id APIs directly.

## Snapshots

Snapshots let hosts pause, reload, or replay event translation/projection.

There are two snapshot types:

- `RuntimeSnapshot` stores harness/thread identity and adapter state.
- `ProjectionSnapshot` stores projection name and projection state.

Snapshots do not include:

- transport connections
- process handles
- auth context
- DB transactions
- HTTP response state
- gateway routing

Those are host concerns.

## Canonical Events Vs Compatibility Events

`AgentRuntimeEvent` is the canonical model.

OpenCode-compatible events are a projection for hosts that need to speak an
OpenCode-shaped stream.

New harness adapters should emit canonical events. New hosts should project
canonical events into their own read models. Do not make OpenCode compatibility
events the source of truth for a new system.

## What To Build Where

| You are building | Put it here |
| --- | --- |
| Translate Claude SDK frames | harness event adapter (`HarnessEventAdapter`) |
| Translate ACP `session/update` frames | harness event adapter (`HarnessEventAdapter`) |
| Convert canonical events to UI rows | projection or host projection |
| Convert canonical events to OpenCode events | `opencode-compat` projection |
| Store events in Postgres/Convex/Supabase | host |
| Authorize users | host |
| Start/stop agent processes | host or SDK runtime |
| Manage sessions and prompts | `@claxedo/agent-sdk-runtime` |

## Read Next

- [api.md](./api.md): exact stable symbols.
- [recipes.md](./recipes.md): copy-paste examples and import style.
- [boundaries.md](./boundaries.md): package ownership rules.
