# Agent SDK Runtime

`@claxedo/agent-sdk-runtime` is the embeddable SDK for running agent harnesses
behind one host-owned runtime API. Register harnesses, choose a store, create a
session, start a turn, and subscribe to events.

## Install

```sh
npm install @claxedo/agent-sdk-runtime
```

```ts
import { createAgentRuntime } from "@claxedo/agent-sdk-runtime"
import { claude } from "@claxedo/agent-sdk-runtime/harnesses/claude"
import { pi } from "@claxedo/agent-sdk-runtime/harnesses/pi"
import { createSqliteRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/sqlite"

const runtime = createAgentRuntime({
  store: createSqliteRuntimeStore({ root: ".agent-runtime" }),
  harnesses: [
    claude({ access: "native" }),
    pi(),
  ],
})

const session = await runtime.sessions.create({
  directory: "/repo",
  harness: { id: "claude", access: "native" },
  model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
  title: "Review",
})

const events = runtime.events.subscribe({ sessionId: session.id })

await runtime.turns.start({
  sessionId: session.id,
  text: "review this repo",
})
```

The package owns harness process/session orchestration, adapter lifecycle,
runtime configuration, model catalogs, MCP resolution, event fan-out, and
first-party stores. Hosts still own auth policy, workspace routing, project
inventory, HTTP route shape, and UI state.

## Agent-First Public Docs

Coding agents and host integrators should start with
[docs/agent.md](./docs/agent.md), then read
[docs/concepts.md](./docs/concepts.md) and
[docs/architecture.md](./docs/architecture.md). Together they define the package job,
mental model, blessed imports, stability labels, boundaries, recipes, and
public API surface.

## Flow

```text
host app
  -> AgentRuntime
  -> harness factory
  -> adapter driver
  -> harness access (ACP / native)
  -> runtime events
  -> runtime.events.subscribe()
```

The canonical event contract comes from `@claxedo/agent-event-runtime`.
Adapters either emit canonical `AgentRuntimeEvent` values directly or emit
OpenCode-compatible `CompatEvent` values when bridging an existing OpenCode
surface.

## Session Liveness And Turn Outcome

`session.status` is the current runtime liveness state. It is `busy` while a
turn is running, `recovering` when a harness is being rebound, `error` when the
session is in an error state, and `null` or absent when it is idle. It is never
`done`.

The durable result of the most recent turn is `session.lastTurn`:

```ts
session.lastTurn?.status // "completed" | "failed" | "cancelled"
session.lastTurn?.assistantMessageId // assistant row for that completed turn
```

Render turn-level "Done", "Failed", or "Cancelled" from `lastTurn`, not from
`message.time.completed`. Message completion is row-level metadata; turn
outcome is recorded by the runtime after the harness stream settles. When a UI
needs to reconcile an in-flight prompt, compare `lastTurn.assistantMessageId`
with the assistant message id for that prompt; `lastTurn.status` alone only
describes the most recent settled turn. If the host has a higher-level lifecycle
such as a Goal or long-running task, use that lifecycle for session-level
"working" and "done" badges. Claude SDK, Codex app-server, ACP, OpenCode, and Pi
terminal signals all normalize through this runtime/store path. Shell hook
integrations remain useful for terminal presence, but they are not the canonical
SDK turn outcome source.

## Goals

A Goal is a session-level completion condition that may span multiple harness
turns. It is a dedicated runtime resource, not a prompt mode: callers use
`runtime.goals`, and adapters must never repair missing support by sending the
objective through `runtime.turns.start()`.

```ts
const capabilities = await runtime.goals.capabilities(session.id, directory)
if (!capabilities.available) throw new Error(capabilities.unavailableReason)

const started = await runtime.goals.start({
  sessionId: session.id,
  objective: "Ship when verification passes",
}, directory)

const current = await runtime.goals.read(session.id, directory)
```

`HarnessCapabilities.goals` is only coarse runtime availability. Always read
the detailed Goal capabilities for the materialized session before rendering
actions. Pause and Resume form one reversible pair; do not expose either unless
both are advertised. Delete is independent. Stop is part of the common Goal
lifecycle and disables continuation before interrupting active work.

| Harness | Start authority | Actions | Recovery |
| --- | --- | --- | --- |
| Codex native | structured app-server Goal RPC | Pause, Resume, Delete | reconcile durable thread state |
| Claude native | SDK `/goal` plus `active_goal` messages | none | blocked if provider state is lost |
| Cursor native | `Agent.send("/goal …")` plus durable Run state | none | blocked if provider state is lost |
| OpenCode native | first-party Session Goal aggregate | Pause, Resume, Delete | reconcile; orphaned execution becomes blocked |
| Pi native | owned evaluator and follow-up controller | Pause, Resume, Delete | blocked after non-durable process loss |
| ACP | negotiated `_meta.goal` extension | negotiated subset | negotiated reconciliation |

Goal snapshots report only provider- or controller-owned fields. Optional
budgets, usage, iteration, and diagnostic reason fields are not synthesized.
After reconnect, refetch `runtime.goals.read()`; `recovery: "blocked"` means an
active persisted snapshot must become visibly blocked rather than complete.

## Layers

### Core Runtime

`src/index.ts` defines the public runtime surface.

- `createAgentRuntime()` is the main public entrypoint.
- `runtime.sessions`, `runtime.turns`, `runtime.goals`, `runtime.events`, `runtime.permissions`,
  `runtime.questions`, `runtime.todos`, `runtime.commands`, `runtime.config`,
  and `runtime.health` are the user-facing resource namespaces.
- `PromptInput` is the normalized message submission shape used across
  transports internally.
- `SessionConfig` and `SessionConfigUpdate` describe harness/model/agent
  selection as host-visible state.

Adapter classes are implementation plumbing behind harness factories. Public
host code should use the runtime facade first.

### Stores

First-party stores live on explicit subpaths:

- `@claxedo/agent-sdk-runtime/stores/memory`
- `@claxedo/agent-sdk-runtime/stores/sqlite`
- `@claxedo/agent-sdk-runtime/stores/convex`

The root import does not load SQLite or Convex.

### Harness Factories

Harness factories have individual entries and a convenience aggregate:

```ts
import { claude, codex, cursor, opencode, pi } from "@claxedo/agent-sdk-runtime/harnesses"
// Smaller single-harness graph:
import { claude as nativeClaude } from "@claxedo/agent-sdk-runtime/harnesses/claude"
```

Factories hide adapter class construction and let the runtime inject store and
event plumbing.

### Harness Metadata

`src/harness-types.ts` is the source of truth for supported harness ids and
access modes.

- ACP harnesses: `claude`, `codex`, and `cursor` with `access: "acp"`.
- Native harnesses: `claude`, `codex`, `cursor`, `opencode`, and `pi` with
  `access: "native"`.

`harnessDefinition()`, `harnessKey()`, `isAgentHarnessId()`, and
`isAgentHarnessAccess()` centralize harness classification so callers do not
infer behavior from strings.

Runtime model options come from live, directory-scoped harness queries. Query
errors are returned to the caller and an empty result remains empty. The
exported SDK model catalog is an explicit reference/validation API; it is not
substituted for a failed live query.

### Subagent support matrix

Subagent discovery is normalized into durable, parent-scoped host rows. A spawn
tool is associated with its row by an explicit `toolCallId` edge. The host mints
`childSessionId` when it can materialize a readable child Session; provider ids
and transcript refs stay opaque and are never treated as Session ids or file
paths by the UI.

| Harness | Discovery | Transcript | Child Session |
| --- | --- | --- | --- |
| OpenCode native | native task/session lifecycle | live | openable |
| Claude native | `Agent` tool lifecycle | messages | openable after host materialization |
| Claude ACP | Claude subagent metadata plus parent-tool correlation | messages | openable after host materialization |
| Codex native | collab thread lifecycle | live | openable |
| Codex ACP | Start/Interact/Interrupt activity | unavailable | not openable |
| Cursor native | `Task` result carrying a valid transcript reference | file | conditionally openable after host materialization |
| Cursor ACP | `Task: Subagent task` lifecycle | unavailable | not openable |
| Pi model-backed | foreground or background child lifecycle | live | openable |
| Pi bare adapter | no subagent capability | none | no subagent row |

Foreground children participate in parent interruption; background children
continue independently and remain visible as background work. Child transcripts
are read-only conversation surfaces: opening one preserves the parent Session,
and repeated activation focuses the existing child surface. Rows with no
supported transcript render an explicit unavailable state with no navigation
control.

Runtime event streams that expose these rows are scoped and authorized by parent
Session. A denied parent subscription returns `403` before replay or live events
are attached, so one parent cannot observe another parent's child lifecycle.

### Capabilities

`src/capabilities.ts` describes runtime feature support.

- `HarnessCapabilities` is the per-harness session feature matrix returned to
  hosts and UI.
- `AdapterCapability` marks implementation abilities that are not part of the
  normal session contract, such as `http-proxy` and `runtime-config`.
- `hasAdapterCapability()` is the safe narrowing helper for optional adapter
  extensions.

Capability data is explicit. Unsupported operations fail rather than returning
synthetic data or events.

### Events And SSE

`src/runtime-event-hub.ts` and `src/sse.ts` provide in-process fan-out and SSE
helpers.

- `RuntimeEventHub` is a lightweight pub/sub boundary for runtime events.
- `createSseReplayBuffer()` keeps bounded replay for reconnecting clients.
- `attachSseFanout()` bridges a subscribe function into a streaming response
  with lifecycle cleanup.

These primitives are production-appropriate when each session is pinned to one
owner machine and that machine's durable session/message log is the source of
truth. Hosts only need external pub/sub when they serve the same session live
from multiple processes or machines.

### Session Environment

`src/session-env.ts` defines the host-provided hands/workspace boundary for a
session.

- `SessionEnv` abstracts command execution, file reads/writes, existence
  checks, and cleanup for harnesses that need delegated workspace operations.
- `SessionHost` and `SandboxRef` describe where the reasoning loop and tool
  execution are placed without binding adapters to a concrete sandbox provider.
- `createMemoryRunStore()` is a small in-memory run-event store for local
  execution.

This is primarily for built-in or central harnesses such as Pi, where the brain
can run in a central process while the hands are supplied by the host. Native
SDK harnesses can ignore `SessionEnv` when their upstream SDK already owns
workspace access. `src/virtual-session-env.ts` provides an in-memory
implementation for tests, demos, and central-only runs.

### MCP Resolution

`src/mcp-resolver.ts` merges managed MCP state with user-defined MCP servers
and converts the result into harness-specific shapes.

- `resolveEffectiveMcp()` returns the effective server map plus managed status.
- `toOpencodeConfig()` writes the OpenCode config shape.
- `toAcpMcpServers()` writes ACP `McpServer` values.

Managed MCP defaults are intentionally empty today. User MCP config still
resolves normally, while managed loops remain explicit no-ops until real managed
servers exist.

### Command Discovery

`src/command-discovery.ts` reads command files from configured directories and
normalizes them into `AgentCommandRow` values. Adapters and hosts use it to
serve slash-command surfaces without making command parsing part of the core
runtime facade.

## Adapters

### ACP

`src/harnesses/acp` owns Agent Client Protocol process integration.

- `index.ts` implements the ACP harness driver.
- `process.ts` manages ACP process lifecycle, prompts, config option probing,
  permissions, and restart behavior.
- `session.ts` translates session load/resume state, mode/model sync, and
  prompt parts into ACP request content.
- `transport.ts` abstracts stdio/http process creation.
- `recovery.ts` and `title.ts` handle recovery metadata and title generation.

ACP adapters should prefer live session config options and only call ACP
session-mode APIs when the advertised mode list supports the requested value.

### Shared SDK Adapter

`src/harnesses/shared` contains reusable lifecycle and projection code for
SDK-backed transports.

- `sdk-runtime-adapter.ts` implements common session storage and adapter
  behavior.
- `turn-lifecycle.ts` owns active-turn cancellation and cleanup rules.
- `turn-projection.ts` bridges harness events into runtime/compat output.

SDK adapters should put harness-specific code in their driver and keep shared
session semantics in this layer.

### Claude SDK, Codex App Server, Cursor SDK

`src/harnesses/claude`, `src/harnesses/codex`, and
`src/harnesses/cursor` adapt native SDK or app-server streams into the
shared runtime contract through the shared SDK adapter.

These transports query their native SDK or app-server for model options and
cache successful results per workspace directory.

### OpenCode

`src/harnesses/opencode` bridges an OpenCode engine into the shared runtime
facade through one of three transports — which one is always the HOST's
decision, never this package's:

- **Injected handler** — construct with `{ request: OpenCodeRequestFn }`; all
  HTTP (sessions, status, `/mcp` sync, the `/global/event` SSE stream) goes
  through the host-supplied `(request: Request) => Promise<Response>` handler.
  Nothing spawns, no socket. This is how a host embeds the engine in-process
  (the host imports the engine; this package never does — see
  `engine-boundary.test.ts`).
- **External URL** — construct with an explicit `opencodeUrl`; requests go to
  that server, whose lifecycle the host owns.
- **Supervised spawn** — construct with neither; the adapter spawns
  `opencode serve` as a supervised child on demand (idle-reaped).

It keeps OpenCode-specific environment and event compatibility code isolated so
the rest of the runtime can operate through the same harness factory and event
projection path as ACP and SDK transports.

### Pi

`src/harnesses/pi` is a built-in native harness. It is useful for placeholder or
host-controlled flows where no external agent process owns a real model/config
surface.

## Host Boundaries

Host packages are responsible for:

- choosing and constructing adapters
- resolving directories and workspace ids
- enforcing auth and operation guards
- owning HTTP/RPC route shape and status codes
- persisting sessions, config, and event history
- publishing global/session events beyond the current process
- exposing product-specific HTTP routes
- materializing agent extensions, skills, and MCP config outside this package

This package should stay focused on runtime contracts and transport execution.

## Adding A Harness

1. Add the harness to `AGENT_HARNESS_DEFINITIONS` in `src/harness-types.ts`.
2. Decide whether it supports `access: "acp"`, `access: "native"`, or both.
3. Implement an adapter under `src/harnesses/<harness>`.
4. Expose explicit `HarnessCapabilities`; unsupported operations must be errors.
5. Implement live model discovery when the harness exposes configurable models.
6. Add focused adapter tests around session lifecycle, submit, abort, config,
   and event projection.
7. Add or update the public factory in `src/harnesses/index.ts` when the
   harness should be user-selectable.

## Public Entry Points

The package ships public docs under `docs/`. Use
[docs/recipes.md](./docs/recipes.md) for import examples and
[docs/api.md](./docs/api.md) for the stable root API.

Entry point status:

- Stable: `@claxedo/agent-sdk-runtime`,
  `@claxedo/agent-sdk-runtime/capabilities`
- Stable: `@claxedo/agent-sdk-runtime/harnesses`,
  `@claxedo/agent-sdk-runtime/stores/memory`,
  `@claxedo/agent-sdk-runtime/stores/sqlite`
- Advanced: `@claxedo/agent-sdk-runtime/adapters`
- Integration: `@claxedo/agent-sdk-runtime/stores/convex`,
  `@claxedo/agent-sdk-runtime/session-env`,
  `@claxedo/agent-sdk-runtime/virtual-session-env`,
  `@claxedo/agent-sdk-runtime/runtime-event-hub`,
  `@claxedo/agent-sdk-runtime/sse`,
  `@claxedo/agent-sdk-runtime/mcp-resolver`
- Compatibility: `@claxedo/agent-sdk-runtime/compat-events`,
  `@claxedo/agent-sdk-runtime/status`

`@claxedo/agent-sdk-runtime/adapters` is public but advanced. Most hosts should
use `createAgentRuntime()` plus harness factories. Use the adapter subpath only
when building a workspace host, custom HTTP compatibility layer, or harness
integration that needs direct driver lifecycle control.

The package publishes built ESM and declaration files from `dist`.

## Verification

Run package checks from the package directory:

```sh
cd packages/agent-sdk-runtime
bun test src
bun typecheck
bun run build
```

Do not run tests from the repository root. This workspace guards against root
test execution.
