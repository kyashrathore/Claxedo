# Stable API

This page describes the intended stable root API for
`@claxedo/agent-event-runtime`.

The runtime core consumes shared events from `@claxedo/agent-runtime-contract`.
Use subpaths for projection implementations. The harness translators are
internal to `@claxedo/harness` transports.

## Event Contract

### `AgentRuntimeEvent`

Status: Stable  
Import: `@claxedo/agent-runtime-contract`
Kind: Type

Canonical cross-harness event union. Projections and hosts should consume this
instead of harness-native payloads.

Use when writing host projections, event stores, replay tools, or tests.

### `agentRuntimeEvent`

Status: Stable  
Import: `@claxedo/agent-runtime-contract`
Kind: Value

Factory object for canonical runtime events. Harness event adapters should use
it so new event kinds remain type-visible.

### Event Registry Values

Status: Stable  
Import: `@claxedo/agent-runtime-contract`
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
Import: `@claxedo/agent-runtime-contract`
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
Import: `@claxedo/agent-runtime-contract`
Kind: Function

Validates the minimal `RawHarnessEvent` shape. It does not parse the native
payload.

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
Import: `@claxedo/agent-runtime-contract`
Kind: Type

Harness-neutral diagnostic object for lossy mappings, unknown frames, and
adapter failures.

### `runtimeDiagnostic`

Status: Stable  
Import: `@claxedo/agent-runtime-contract`
Kind: Function

Creates a diagnostic with normalized severity.

### `normalizeDiagnostics`

Status: Stable  
Import: `@claxedo/agent-runtime-contract`
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
Import: `@claxedo/agent-runtime-contract`

Determinism helpers:

- `Clock`
- `CreateId`
- `systemClock`
- `createSequentialIdFactory`

Use injected clocks and id factories in tests and replay tools.
