# Agent Event Runtime Architecture

`@claxedo/agent-event-runtime` owns harness event normalization and projection.
It turns harness-native event frames from external agent harnesses into
canonical `AgentRuntimeEvent` values, then lets host packages project those
events into UI, compatibility, replay, or diagnostic formats.

The package is intentionally browser-safe. Hosts still own process management,
stdio, WebSocket, EventSource, storage, HTTP routes, and persistence.

## Agent-First Public Docs

Coding agents and host integrators should start with
[docs/agent.md](./docs/agent.md). If the model is not obvious yet, read
[docs/concepts.md](./docs/concepts.md) next. These docs define the package job,
mental model, stability labels, boundaries, recipes, and public API.

## Flow

```text
native harness event frame
  -> RawHarnessEvent
  -> Harness event adapter state
  -> AgentRuntimeEvent[]
  -> RuntimeProjection state
  -> compat events / debug traces / host-specific views
```

The runtime can sit on the server, in the browser, or in tests. The same
adapter and projection code should produce the same canonical event stream when
given the same raw harness event frames, clock, id factory, and snapshots.

A snapshot is a serializable checkpoint for resuming one state boundary:
`RuntimeSnapshot` resumes harness-frame-to-canonical-event translation, while
`ProjectionSnapshot` resumes canonical-event-to-output-view projection.

## Layers

### Contracts

`src/contracts` defines the cross-harness data model.

- `RawHarnessEvent` is the ingress envelope. It carries `source`, optional
  `method`, raw `payload`, and optional `receivedAt`.
- `AgentRuntimeEvent` is the canonical event union used between harness event
  adapters and projections.
- `agentRuntimeEvent` factories construct canonical events and keep event-kind
  drift visible to TypeScript.
- `ToolDisplay` and `ToolIntent` carry harness-neutral tool metadata that
  projections need for cards, labels, paths, commands, and search details.
- diagnostics describe lossy mappings, unknown harness events, and runtime
  adapter failures without crashing the stream.

### Core Runtime

`src/core` contains the harness-agnostic state machine.

- `createAgentEventRuntime()` owns one adapter state value for one
  harness/thread pair.
- `translateRawHarnessEvent()` is the pure reducer API for replay and tests.
- `HarnessEventAdapter` is the TypeScript name for the harness event adapter
  boundary.
- `RuntimeProjection` is the boundary each output projection implements.
- `createAdapterRegistry()` is a small name-to-adapter registry for hosts that
  select harness event adapters dynamically.

The runtime stamps emitted events with `harness`, `threadId`, and `raw`.
`harness` is the current API field for the external harness/source id. The
runtime also catches adapter exceptions and turns them into diagnostic events,
so a bad frame does not tear down the host stream.

### Harness Event Adapters

`src/harnesses` contains harness event adapters. External harness event
sources are identified by a `harness` id, and harness event adapters
translate harness-native payloads into canonical runtime events.

- `acp` maps ACP `session/update` notifications and preserves ACP-specific
  details in metadata.
- `claude-sdk` maps Claude Agent SDK messages, tool lifecycle updates, todos,
  rate limits, auth status, and result events.
- `cursor-sdk` maps Cursor SDK local run stream events and SDK messages.
- `codex-app-server` maps Codex app-server protocol notifications and requests.
- `tool-display.ts` extracts common harness-neutral display facts from tool
  names, kinds, and inputs.
- `value.ts` contains small shape readers for untrusted harness payloads.

Adapters own only translation state. They do not start processes, perform I/O,
persist data, or know about OpenCode compatibility events.

### Projections

`src/projections` turns canonical runtime events into output-specific views.

- `opencode-compat` incrementally emits OpenCode-compatible event envelopes.
  It tracks assistant text, reasoning text, plan text, tool parts, tool status,
  tool outputs, and split part ids.
- `debug-trace` emits compact trace rows with runtime type, harness, thread,
  raw payload, and diagnostics.

Projections own their own state and snapshots. They should not mutate adapter
state or depend on harness-native payloads except through diagnostic metadata.

### Test Utilities

`src/test-utils/replay.ts` provides fixture replay for deterministic tests. Use
it when checking that a set of raw harness event frames still produces the expected
canonical stream.

## Snapshots

There are two explicit restore boundaries:

- `RuntimeSnapshot` stores harness/source id, thread id, snapshot version, and adapter
  state.
- `ProjectionSnapshot` stores projection name, snapshot version, and projection
  state.

Runtime snapshots do not include host transport state, persisted event stores,
or the default sequential id counter. Hosts that need stable fallback ids after
restore should provide a persisted `createId` implementation.

Both runtime and projection snapshots use `cloneSnapshotValue()` to avoid
sharing mutable state with callers. The primary path uses `structuredClone`;
the fallback constrains values to JSON-safe data.

## Determinism

`createAgentEventRuntime()` accepts injected `clock` and `createId` functions.
Adapters should use those context functions whenever they need timestamps or
fallback ids.

`createOpencodeCompatProjection()` accepts its own `clock` because compatibility
events have their own timestamp boundary.

Tests should inject deterministic clocks and ids for replay parity. Production
callers can omit them and use the defaults.

## Adding A Harness Adapter

1. Add a folder under `src/harnesses/<harness>`.
2. Export an adapter factory from that folder (existing adapters use the
   `<harness>Adapter()` naming style, e.g. `claudeSdkAdapter()`).
3. Keep harness payload parsing local to the adapter.
4. Emit `AgentRuntimeEvent` values through the canonical event contract.
5. Preserve harness-specific details in `metadata`, not in new event variants,
   unless another harness adapter or projection needs the same concept.
6. Use `ToolDisplay` for projection-critical tool facts.
7. Add adapter tests with real harness-shaped frames and diagnostics for
   unmapped events.
8. Add the harness adapter entry point to `src/index.ts`, `package.json` exports, and
   `scripts/build.ts` when it should be public.

## Adding A Projection

1. Add a folder under `src/projections/<projection>`.
2. Implement `RuntimeProjection<Event, State>`.
3. Keep all output-specific ids, accumulated text, and part maps in projection
   state.
4. Return incremental events from `ingest()`; do not require a full history.
5. Add `ProjectionSnapshot` support for reload and replay.
6. Add tests that assert observable output, not private helper choreography.
7. Add public exports and a build entry when the projection should be consumed
   directly.

## Public Entry Points

The package ships public docs under `docs/`. Use
[docs/recipes.md](./docs/recipes.md) for import examples and
[docs/api.md](./docs/api.md) for the intended stable root API.

Entry point status:

- Stable: `@claxedo/agent-event-runtime`,
  `@claxedo/agent-event-runtime/contracts`
- Integration: `@claxedo/agent-event-runtime/harnesses/acp`,
  `@claxedo/agent-event-runtime/harnesses/claude`,
  `@claxedo/agent-event-runtime/harnesses/codex`,
  `@claxedo/agent-event-runtime/harnesses/cursor`,
  `@claxedo/agent-event-runtime/projections/debug-trace`
- Compatibility:
  `@claxedo/agent-event-runtime/projections/opencode-compat`

The package publishes built ESM and declaration files from `dist`.

## Verification

Run package checks from the package directory:

```sh
cd packages/agent-event-runtime
bun test src
bun typecheck
bun run build
```

Do not run tests from the repository root. This workspace guards against root
test execution.
