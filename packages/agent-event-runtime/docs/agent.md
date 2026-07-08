# Agent Guide

This is the first file a coding agent should read when using
`@claxedo/agent-event-runtime`.

## Mental Model

This package is a translation layer.

It does not run an agent harness. It does not store sessions. It does not
expose HTTP routes. It takes event frames from external agent harnesses,
normalizes them into one canonical event stream, and lets hosts project that
stream into whatever shape they need.

```text
harness-native event frame
  -> RawHarnessEvent
  -> harness event adapter
  -> AgentRuntimeEvent
  -> RuntimeProjection
  -> host view / debug trace / OpenCode compatibility stream
```

The core idea is:

- external harnesses speak different event languages
- hosts should not need to understand every harness event language
- harness event adapters translate those frames into `AgentRuntimeEvent`
- projections translate `AgentRuntimeEvent` into output views

External harness event sources are identified by a `harness` id.
The TypeScript API names a harness event adapter `HarnessEventAdapter`.

Read [concepts.md](./concepts.md) before the API reference if this model is not
already obvious.

## First-Time Read Path

1. Read [concepts.md](./concepts.md) to build the mental model.
2. Read [boundaries.md](./boundaries.md) to understand what this package must
   not own.
3. Read [recipes.md](./recipes.md) for copy-paste usage and import examples.
4. Read [api.md](./api.md) only when you need exact stable symbols.

## Package Job

Use this package when you have harness-native event frames and want canonical
runtime events.

Use a different package when you need to start processes, manage runner
sessions, authorize users, persist data, expose routes, or sync workspaces.
Those concerns belong to a host or to `@claxedo/agent-sdk-runtime`.

## Decision Table

| Need | Read |
| --- | --- |
| Understand the model | [concepts.md](./concepts.md) |
| Understand ownership boundaries | [boundaries.md](./boundaries.md) |
| Translate one harness frame | [recipes.md](./recipes.md#translate-one-raw-event) |
| Use a projection | [recipes.md](./recipes.md#use-a-projection) |
| Create a debug trace | [recipes.md](./recipes.md#create-a-debug-trace) |
| Implement a harness event adapter | [recipes.md](./recipes.md#implement-a-harness-event-adapter) |
| Use snapshots | [recipes.md](./recipes.md#snapshot-and-restore) |
| Look up exact stable symbols | [api.md](./api.md) |

## Stability Labels

| Label | Meaning |
| --- | --- |
| Stable | Intended public API for external hosts. |
| Integration | Public harness-adapter/projection API. Import from explicit subpaths. |
| Compatibility | Bridge for OpenCode or legacy Claxedo shapes. Do not build new canonical models around it. |
| Experimental | Public but may change before 1.0. |
| Internal | Not a supported public import. |
| Deprecated | Old API kept temporarily. |

## Default Import Rules

Use root imports only for canonical contracts and harness-agnostic runtime
primitives:

```ts
import {
  createAgentEventRuntime,
  agentRuntimeEvent,
  type AgentRuntimeEvent,
  type HarnessEventAdapter,
} from "@claxedo/agent-event-runtime"
```

Use subpaths for harness adapter and projection implementations:

```ts
import { claudeSdkAdapter } from "@claxedo/agent-event-runtime/harnesses/claude"
import { createOpencodeCompatProjection } from "@claxedo/agent-event-runtime/projections/opencode-compat"
```

New code should use the import style shown in [recipes.md](./recipes.md).
