# Stable API

This page describes the intended stable root API for
`@claxedo/agent-sdk-runtime`.

The root export is the public `AgentRuntime` facade and shared runtime types.
Use subpaths for harness factories, stores, compatibility helpers, SSE, MCP,
and session-environment utilities.

## Runtime Facade

### `createAgentRuntime`

Status: Stable  
Import: `@claxedo/agent-sdk-runtime`  
Kind: Function

Creates the public resource-namespace runtime:

- `runtime.sessions`
- `runtime.turns`
- `runtime.events`
- `runtime.permissions`
- `runtime.questions`
- `runtime.todos`
- `runtime.commands`
- `runtime.config`
- `runtime.health`

Session-scoped mutations are serialized per session. `sessions.update`, both
config update namespaces, harness handoff, and `sessions.delete` revalidate the
session inside that boundary. Missing sessions and configs reject explicitly;
the runtime does not recreate them. Optional surfaces such as todos, commands,
permissions, and questions reject with a not-found or unsupported error instead
of returning a fabricated empty result.

The runtime store is authoritative for session inventory and `SessionConfig`.
Adapters apply provider or process effects and return the accepted value; the
runtime persists it once. `runtime.sessions.updateConfig()` and
`runtime.config.update()` share the same implementation. Changing `harness`
uses the conversation-handoff transaction rather than an ordinary config write.

Each event subscription has a fixed buffer. Overflow yields one
`runtime.subscription_overflow` notice and closes the subscription. Reconnect
and reload the authoritative session/message/config projections. When
`eventDelivery` is configured, every subscription must provide `identity`; the
runtime fails closed when identity is absent or the policy terminates or rejects.

### Store Subpaths

Status: Stable / Integration
Kind: Functions

- `createMemoryRuntimeStore` from `@claxedo/agent-sdk-runtime/stores/memory`
- `createSqliteRuntimeStore` from `@claxedo/agent-sdk-runtime/stores/sqlite`

The root import does not load SQLite.

### Harness Factories

Status: Stable  
Import: `@claxedo/agent-sdk-runtime/harnesses`
Kind: Functions

- `claude`
- `codex`
- `cursor`
- `opencode`
- `pi`
- `acp(id, options)` for an explicit operator-configured ACP connection

Use factories with `createAgentRuntime()` instead of constructing adapter
classes directly.

## Advanced Adapter API

Status: Advanced
Import: `@claxedo/agent-sdk-runtime/adapters`

Most hosts should register harness factories from
`@claxedo/agent-sdk-runtime/harnesses` and call the `AgentRuntime` resource
namespaces. The adapter subpath is public for hosts that need lower-level driver
control, such as a workspace host, compatibility proxy, or custom harness
integration.

Exports include:

- `AgentHarnessAdapter`
- `AgentHandoffSessionOptions`
- `AgentPreparedHandoffSession`
- `AcpHarnessAdapter`
- `ClaudeHarnessAdapter`
- `CodexHarnessAdapter`
- `CursorHarnessAdapter`
- `OpenCodeHarnessAdapter`
- `PiHarnessAdapter`
- ACP transport factories
- `AgentRuntimeStoreWithRecovery`

This is a real public API surface, but it is not the recommended starting point.

Custom adapters that support harness switching implement `createHandoffSession`
as a prepare step. It returns an idempotent `rollback()` that releases only the
new target resources. After a successful commit, `releaseHandoffSource` may
release the old provider-native session. A target that already owns the same
logical session id must reject preparation rather than delete that session.

## Prompt And Config Types

Status: Stable  
Import: `@claxedo/agent-sdk-runtime`

Types:

- `PromptInput`
- `PromptModel`
- `PromptFormat`
- `SessionHarness`
- `SessionConfig`
- `SessionConfigUpdate`

These describe host-visible prompt submission and harness/model/agent selection.
They do not encode product authorization or database policy.

`SessionConfig` is the complete current config. `SessionConfigUpdate` is a
partial mutation request:

- `undefined` means leave the field unchanged.
- `null` means clear an optional nullable field.
- a value means replace that field.

`harness` updates replace the whole `SessionHarness`; they are not deep merged.

## Host-Visible Rows

Status: Stable  
Import: `@claxedo/agent-sdk-runtime`

Types:

- `AgentSession`
- `AgentTurnOutcome`
- `AgentMessage`
- `AgentPermission`
- `AgentQuestion`
- `AgentCommand`
- `AgentAgent`
- `AgentConfigOption`

These are normalized host-facing shapes. Harness-native data should stay in
`harnessPayload` until a stable cross-harness field exists.

`AgentSession.status` describes current liveness only. Hosts should render
post-turn outcome from `AgentSession.lastTurn?: AgentTurnOutcome`, whose status
is exactly `completed`, `failed`, or `cancelled`. A completed assistant message
is not the same as a completed turn. `AgentTurnOutcome.assistantMessageId`
identifies the assistant message row for the settled turn so hosts can correlate
the outcome with a specific submitted prompt.

Deprecated aliases ending in `Row` currently exist for migration. Prefer the
non-`Row` names in new code.

## Runtime Results

Status: Stable  
Import: `@claxedo/agent-sdk-runtime`

Types:

- `AgentRuntimeAbortResult`
- `AgentRuntimeHealth`
- `AgentRuntimePermissionDecision`
- `AgentRuntimeInteractionResult`
- `RuntimeDirectory`

Use these in host routes and RPC layers that expose runtime interactions.

## Capabilities

Status: Stable  
Import: `@claxedo/agent-sdk-runtime`

Exports:

- `HarnessCapabilities`
- `HarnessCapabilityTarget`
- `harnessCapabilities`

These describe the capabilities a host can show in UI or use for feature
gating at the runtime facade layer.

Advanced adapter capability helpers live behind explicit subpaths.

Import: `@claxedo/agent-sdk-runtime/capabilities`

- `HarnessCapabilityContext`
- `AdapterCapability`
- `AdapterCapabilityProvider`
- `hasAdapterCapability`

Import: `@claxedo/agent-sdk-runtime/adapters`

- `HttpProxyAdapter`
- `RuntimeConfigurableAdapter`

Capability data should be explicit. Do not infer support from harness names when
the adapter can report it.

## Canonical Events

Status: Stable  
Import: `@claxedo/agent-sdk-runtime`

Type:

- `AgentRuntimeEvent`

This is re-exported from `@claxedo/agent-event-runtime` for host convenience.
It is the canonical event model.

Compatibility events are not canonical; import them from
`@claxedo/agent-sdk-runtime/compat-events` when needed.
