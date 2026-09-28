# Concepts

## The Short Version

A session is a durable row bound to one harness execution. A turn is one
admitted prompt: the store hands out a lease, the runtime host runs the prompt
on a harness transport, canonical events are committed and projected to
clients, and the turn is finished under that same lease. This package defines
the rows, the prompt, the config helpers and the projections; the runtime host
and transports do the running.

## The Main Objects

### SessionHarness

`{ id, access }`: a native harness (`claude`, `codex`, `cursor`, `pi`, `opencode`) or a configured connection. `AGENT_HARNESS_DEFINITIONS`, `harnessKey`, `normalizeHarnessIdentity` and `connectionIdForHarness` are the one table for harness identity.

### SessionConfig

What a session was created with and may be updated to: `harness`, `model`, `variant` (effort), `agent`, `permissionMode`, `permissionCeiling`, `instructions`, `group`, `handoff`. `IMMUTABLE_SESSION_CONFIG_FIELDS` (`instructions`, `group`) are fixed at create; an update naming one is refused, not dropped.

### PromptInput

One turn's prompt: `parts`, `userMessageId`, `assistantMessageId`, `agent`, optional `model`, `system`, `tools`, `format`, `variant`, `author`. `resolveSessionModel` and `resolveTurnSystem` fill the model and system block from the session config where the turn named none.

### Instructions

A retained instruction block travels on the channel the harness declares (`HarnessInstructionChannel`): at session start, on every turn's system prompt, or at the head of the user's prompt. `admitSessionInstructions` refuses a block on a harness with no channel and one over `SESSION_INSTRUCTIONS_MAX_BYTES`.

### Permission ceilings

A child session may equal or narrow its parent's ceiling, never widen it. Modes carry an `AutoLevel` rung (`ask` < `auto` < `full`); `permissionModeLevel`, `permissionCeilingAdmits` and `widestPermissionModeUnder` are the arithmetic.

### HarnessCapabilities

What a harness offers a session: request kinds, todos, commands, fork, config options, subagents, goal availability, effort levels per model, and the instruction channel. The runtime host projects it from the transport's declared capabilities.

### Provider projections

`ProviderProjection` is a base URL plus a placeholder credential (or an unavailable marker with a reason). `providerProjectionRecord` validates a pushed record; `projectionRenewalDue` says when a placeholder must be renewed.

### Runtime Events

Transports yield `AgentRuntimeEvent`s. `./compat-events` turns them into the client-presentation frames (`message.updated`, `message.part.updated`, `session.idle`, `session.error`, `permission.asked`, `question.asked`, …) that clients render; `isRetainedCompatEvent` says which frames a transcript keeps.

## Session State Vs Host State

Session state (rows of the store contract) is owned by the runtime host. Host state (who may see a session, project inventory, UI state) never enters these shapes; the store carries only what a turn needs to run and be replayed.

## How This Package Fits

`@claxedo/agent-runtime-contract` → this package → `@claxedo/workspace-runtime` (runtime host) and `@claxedo/harness` (transports). Clients import the compat event shapes and the session types; hosts import the config helpers and the store contract.
