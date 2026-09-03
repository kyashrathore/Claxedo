# Concepts

This page builds the mental model for `@claxedo/agent-sdk-runtime`.

## The Short Version

Agent harnesses expose different control surfaces. ACP binaries, native SDKs,
OpenCode HTTP servers, and Pi do not create sessions, send
messages, stream events, or report capabilities in the same way.

This package gives hosts one harness-control language:

```text
host request
  -> AgentRuntime
  -> harness factory
  -> adapter driver
  -> harness access (ACP or native)
  -> runtime event stream
  -> runtime.events.subscribe()
```

The package answers: "How does a host talk to an agent harness?"

`@claxedo/agent-event-runtime` answers a lower-level question: "How do native
harness event frames become canonical `AgentRuntimeEvent` values?"

## The Main Objects

### Agent Harness

An agent harness is the agent application or control surface that can execute
an agent turn.

Examples:

- Claude over ACP
- Codex over ACP
- Cursor over ACP
- Claude Agent SDK
- Codex app-server
- Cursor SDK
- OpenCode HTTP
- Pi

The package names supported harnesses with `AgentHarnessId` and describes them
in `AGENT_HARNESS_DEFINITIONS`.

Harness access tells the host how the harness is controlled:

```text
acp    -> Agent Client Protocol process or remote ACP transport
native -> the harness's native SDK, app-server, HTTP API, or built-in adapter
```

Harness id and harness access are routing hints, not product policy. They do
not decide who can use a harness, which workspace it belongs to, or how usage is
billed.

### AgentRuntime

`AgentRuntime` is the main public API.

It answers: "What can my host do with agent sessions?"

The facade is organized into resource namespaces:

- `sessions` for create/list/get/update/delete/config
- `turns` for start/abort
- `events` for subscription and replay reads
- `permissions` and `questions` for interactive harness checkpoints
- `todos`, `commands`, `config`, and `health` for optional harness surfaces

The runtime owns prompt construction, generated message ids, background turn
execution, event fan-out, and adapter selection.

It also owns the split between session liveness and turn outcome. A session row
uses `status` for current liveness only: `busy`, `recovering`, `error`, or
idle/null. The most recent turn result is projected separately as
`lastTurn.status`: `completed`, `failed`, or `cancelled`. The optional
`lastTurn.assistantMessageId` identifies the assistant message row for that
settled turn, which lets UIs avoid treating an older turn outcome as the result
of a currently busy prompt.

UI should derive turn-level labels from both fields:

```text
status === "busy"                       -> Running
status === "recovering"                 -> Recovering
lastTurn.status === "completed"         -> Done
lastTurn.status === "failed"            -> Failed
lastTurn.status === "cancelled"         -> Cancelled
no turns/messages                       -> New
otherwise                               -> Idle
```

These labels describe the most recent harness turn. If your product has a
higher-level lifecycle, such as a Goal that can continue across multiple
turns, that lifecycle owns the session-level "working" and "done" badges.

Do not use `message.time.completed` as proof that a turn completed. An
assistant message can finish before tools, permission checks, protocol errors,
or stream cleanup finish. Native SDK streams, app-server turn events, ACP stop
reasons, OpenCode compat events, and Pi runtime events normalize into the
runtime/store outcome projection. CLI hook injection is terminal lifecycle
visibility, not the durable source for SDK-owned turn outcomes.

## Goal State Is Independent From Turn State

A Goal is one session-level objective whose executor may accept several real
turns before reaching a terminal condition. `session.status` still describes
the current turn; `runtime.goals.read()` describes the longer-lived Goal. A
settled turn therefore does not imply that an active Goal is complete.

Goal submission uses `runtime.goals.start()`. It never enters `PromptInput`, an
ordinary slash-command dispatcher, or `runtime.turns.start()`. Each adapter
owns the translation to its authoritative Goal mechanism. Missing support is a
capability error rather than permission to send the objective as ordinary text.

Detailed capabilities separate implementation, current availability, actions,
recovery, and optional snapshot fields. Pause and Resume are a pair. Delete is
advertised independently. On reconnect, the host reads Goal state from the
adapter authority; if the underlying execution cannot be restored, the state
becomes `blocked` instead of being inferred as `complete`.

```ts
import { createAgentRuntime } from "@claxedo/agent-sdk-runtime"
import { pi } from "@claxedo/agent-sdk-runtime/harnesses"
import { createMemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"

const runtime = createAgentRuntime({
  store: createMemoryRuntimeStore(),
  harnesses: [pi()],
})
```

### Harness Factories

Harness factories register one harness family or access mode with an
`AgentRuntime`.

Examples:

```ts
import { claude, codex, opencode, pi } from "@claxedo/agent-sdk-runtime/harnesses"

const harnesses = [
  claude({ access: "native" }),
  codex({ access: "acp" }),
  opencode({ url: "http://127.0.0.1:4096" }),
  pi(),
]
```

The factory owns harness-specific construction details such as process binary,
remote URL, SDK driver, and transport setup.

The adapter does not own product auth, workspace sharing, channel dedupe,
database sync, route policy, gateway selection, or billing.

### SessionConfig

`SessionConfig` is the complete host-visible harness selection for a session.

It can describe:

- harness id
- harness access
- harness process or remote connection
- model
- agent
- variant

Example:

```ts
const config = {
  harness: {
    id: "claude",
    access: "acp",
    connection: {
      kind: "remote",
      transport: "streamable-http",
      url: "http://127.0.0.1:47342/acp",
    },
  },
  model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  agent: "default",
}
```

`SessionConfig` should stay generic. If a host has product-specific workspace,
billing, sharing, or org metadata, keep that beside the session in host storage
instead of adding it to the harness config.

`SessionConfigUpdate` is the partial update shape used when changing config.
Its rules are:

```text
undefined -> leave this field unchanged
null      -> clear this optional nullable field
value     -> replace this field
```

`harness` is a full replacement. Do not treat `harness` updates as a nested
merge.

### PromptInput

`PromptInput` is the normalized input for an agent turn.

It includes message parts, target model, agent name, optional tool settings,
optional structured-output format, and model-provider escape hatches.

It answers: "What should the harness do next?"

Adapters translate this shape into the harness's native request format.

### SessionEnv

`SessionEnv` is the host-provided hands/workspace boundary for a session.

It answers: "When the harness brain is running here, where do its hands execute?"

This matters for harnesses such as Pi, where the control loop can run in a
central server but file and command operations may be local, remote, sandboxed,
or virtual. Native Claude/Codex/Cursor adapters do not have to use
`SessionEnv` when their upstream SDK or app-server already owns workspace
access.

The interface includes:

- current working directory
- path resolution
- command execution
- file reads and writes
- directory operations
- stat and existence checks
- optional cleanup

Hosts provide the environment. This package also ships
`createVirtualSessionEnv` for tests, demos, and central-only runs:

```ts
import { createVirtualSessionEnv } from "@claxedo/agent-sdk-runtime/virtual-session-env"

const env = createVirtualSessionEnv({
  cwd: "/workspace",
  files: {
    "/workspace/README.md": "hello",
  },
})
```

`SessionEnvFactoryInput` carries placement hints:

- `mode`: local, cloud, or hybrid
- `host`: where the harness brain/control loop is running
- `workspaceId`: host-owned workspace identity
- `toolSandbox`: where the hands/tool execution should happen

These are hints from the host to the runtime boundary. They do not grant access
by themselves.

### HarnessCapabilities

Not every harness supports every action.

`HarnessCapabilities` answers: "Which user/session features are available for
this harness right now?"

Examples:

- `abort`
- `replay`
- `permissions`
- `questions`
- `todos`
- `commands`
- `fork`
- `revert`
- `configOptions`

Use capabilities or optional method checks before calling optional behavior.
Do not infer behavior from harness names when the adapter can report it.

### AdapterCapability

`AdapterCapability` is different from `HarnessCapabilities`.

`HarnessCapabilities` describes user/session features like abort, fork, and
permissions.

`AdapterCapability` describes adapter-level host integration features:

- `http-proxy`: the adapter can expose a backing HTTP server for selected
  compatibility routes
- `runtime-config`: the host can push runtime config such as model/auth updates

The public runtime facade checks capabilities before calling optional adapter
methods.

### Runtime Events

At the runtime layer, turns and event delivery are separate:

```ts
const events = runtime.events.subscribe({ sessionId })
await runtime.turns.start({ sessionId, text: "review this repo" })
```

The host can expose that subscription over SSE, WebSocket, or another realtime
system. The turn-start call is not the client-facing response stream.

`AgentRuntimeEvent` is the canonical event model from
`@claxedo/agent-event-runtime`.

`CompatEvent` is an OpenCode-compatible bridge event. It exists so hosts can
serve old or OpenCode-shaped clients while the canonical event model matures.
New host logic should prefer canonical runtime events when possible.

## Event Flow

```text
1. Host receives a user/request/channel action
   Example: "send this prompt to session abc".

2. Host resolves product policy
   Auth, workspace access, channel idempotency, billing, route exposure, and
   gateway selection happen outside this package.

3. Host creates or reads a session config
   The choice may come from SessionConfig, user settings, workspace defaults,
   or control-plane placement.

4. AgentRuntime chooses a registered harness factory
   The runtime constructs or reuses the adapter driver for that harness.

5. Runtime publishes turn events
   The stream can contain canonical AgentRuntimeEvent values and compatibility
   events.

6. Host projects and stores what it needs
   The host can publish to a separate SSE/WebSocket endpoint, write DB rows,
   update UI state, record audits, or sync visibility.
```

The adapter does not decide whether the current user may see the session. The
host must apply that before and after adapter calls.

## Session State Vs Host State

Keep these boundaries separate:

```text
Harness/session state
  belongs to AgentRuntime, its store, and the harness adapter

Host product state
  belongs to the application using the package
```

Harness/session state includes messages, runtime config, harness health, pending
permissions, questions, todos, and command execution state.

Host product state includes users, orgs, workspace shares, database visibility,
channel ids, audit logs, billing, and HTTP route policy.

`harnessPayload` fields exist for data that is still harness-native. Use them as
escape hatches, not as the primary product model.

## Choosing Imports

Use root imports for the runtime facade and shared host types:

```ts
import {
  createAgentRuntime,
  type AgentSession,
  type SessionConfig,
} from "@claxedo/agent-sdk-runtime"
```

Use subpaths for harness factories, stores, and integration utilities:

```ts
import { claude, pi } from "@claxedo/agent-sdk-runtime/harnesses"
import { createSqliteRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/sqlite"
import { createRuntimeEventHub } from "@claxedo/agent-sdk-runtime/runtime-event-hub"
import { createVirtualSessionEnv } from "@claxedo/agent-sdk-runtime/virtual-session-env"
```

Use the advanced adapter subpath only when building a workspace host,
compatibility proxy, or custom harness integration:

```ts
import { AcpHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
```

Do not import files under `src`, `dist`, or `harnesses/shared`.

## How This Package Fits With Agent Event Runtime

Use `@claxedo/agent-sdk-runtime` when you need to control a harness.

Use `@claxedo/agent-event-runtime` when you need to translate or project
runtime events.

In practice, concrete SDK-runtime adapters often use event-runtime internally:

```text
harness-native stream
  -> concrete harness adapter
  -> event-runtime translation/projection
  -> adapter driver
  -> AgentRuntime events
  -> host subscription
```

External hosts should usually start with `createAgentRuntime()`. Reach for
`@claxedo/agent-event-runtime` directly when building a new harness adapter,
custom event projection, replay tool, or diagnostics pipeline.
