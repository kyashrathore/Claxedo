# Stable API

This page describes the intended stable root API for
`@claxedo/agent-event-runtime`.

The root export is the public event contract and runtime core. Use subpaths for
harness-adapter and projection implementations.

## Event Contract

### `AgentRuntimeEvent`

Status: Stable  
Import: `@claxedo/agent-event-runtime`  
Kind: Type

Canonical cross-harness event union. Projections and hosts should consume this
instead of harness-native payloads.

Use when writing host projections, event stores, replay tools, or tests.

### `agentRuntimeEvent`

Status: Stable  
Import: `@claxedo/agent-event-runtime`  
Kind: Value

Factory object for canonical runtime events. Harness event adapters should use
it so new event kinds remain type-visible.

### Event Registry Values

Status: Stable  
Import: `@claxedo/agent-event-runtime`  
Kind: Values and types

Includes:

- `AGENT_RUNTIME_EVENT_CONTRACT_VERSION`
- `AGENT_RUNTIME_EVENT_TYPES`
- `AGENT_RUNTIME_EVENT_TYPE_REGISTRY`
- `AgentRuntimeEventType`
- `AgentRuntimeEventOf`
- `AgentRuntimeEventInput`

Use these for validation, diagnostics, and tooling.

## Raw Harness Input

### `RawHarnessEvent`

Status: Stable  
Import: `@claxedo/agent-event-runtime`  
Kind: Type

Ingress envelope for harness-native event frames.

```ts
type RawHarnessEvent = {
  source: string
  method?: string
  payload: unknown
  receivedAt?: number
}
```

`source` should identify the external harness or transport. `payload` is
intentionally unknown until a harness event adapter parses it.

### `rawHarnessEvent`

Status: Stable  
Import: `@claxedo/agent-event-runtime`  
Kind: Function

Validates the minimal `RawHarnessEvent` shape. It does not parse the native
payload.

## Harness Event Adapter Contract

### `HarnessEventAdapter`

Status: Stable  
Import: `@claxedo/agent-event-runtime`  
Kind: Type

Harness event translation boundary. External harness event sources are
identified by a `harness` id, and this interface is named
`HarnessEventAdapter`.

A harness event adapter receives one `RawHarnessEvent`, its previous adapter
state, and deterministic runtime context. It returns canonical events, updated
state, and optional diagnostics.

Use this when adding a harness event translator.

### `HarnessEventAdapterContext`

Status: Stable  
Import: `@claxedo/agent-event-runtime`  
Kind: Type

Context supplied to adapters:

- `harness` (the external harness/source id)
- `threadId`
- `now`
- `createId`

Adapters should use `now` and `createId` instead of calling global time or
random id APIs directly.

### `translateRawHarnessEvent`

Status: Stable  
Import: `@claxedo/agent-event-runtime`  
Kind: Function

Pure translation helper for replay and tests. It catches adapter failures and
converts them into diagnostic events.

### `createAgentEventRuntime`

Status: Stable  
Import: `@claxedo/agent-event-runtime`  
Kind: Function

Creates a stateful event runtime for one harness/thread pair. Use when a host
wants incremental ingest plus snapshots. A snapshot is a serializable
checkpoint for resuming translation without replaying every prior harness event
frame.

## Projection Contract

### `RuntimeProjection`

Status: Stable  
Import: `@claxedo/agent-event-runtime`  
Kind: Type

Projection boundary from canonical `AgentRuntimeEvent` values to another view.

Use this for UI views, compatibility event streams, debug traces, persisted read
models, or tests.

## Diagnostics

### `RuntimeDiagnostic`

Status: Stable  
Import: `@claxedo/agent-event-runtime`  
Kind: Type

Harness-neutral diagnostic object for lossy mappings, unknown frames, and
adapter failures.

### `runtimeDiagnostic`

Status: Stable  
Import: `@claxedo/agent-event-runtime`  
Kind: Function

Creates a diagnostic with normalized severity.

### `normalizeDiagnostics`

Status: Stable  
Import: `@claxedo/agent-event-runtime`  
Kind: Function

Converts unknown diagnostic values into a safe diagnostic list.

## Snapshots

Status: Stable  
Import: `@claxedo/agent-event-runtime`

Snapshot API:

- `RuntimeSnapshot`
- `ProjectionSnapshot`
- `runtimeSnapshot`
- `projectionSnapshot`
- `assertRuntimeSnapshot`
- `cloneSnapshotValue`
- `RUNTIME_SNAPSHOT_VERSION`
- `PROJECTION_SNAPSHOT_VERSION`

Use snapshots for replay, reload, and deterministic tests. `RuntimeSnapshot`
resumes harness-frame-to-canonical-event translation. `ProjectionSnapshot`
resumes canonical-event-to-output-view projection. Snapshots do not own
transport state, process handles, DB rows, auth state, or HTTP connection state.

## Determinism

Status: Stable  
Import: `@claxedo/agent-event-runtime`

Determinism helpers:

- `Clock`
- `CreateId`
- `systemClock`
- `createSequentialIdFactory`

Use injected clocks and id factories in tests and replay tools.
