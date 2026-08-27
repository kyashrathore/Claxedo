# Agent SDK Runtime

`@claxedo/agent-sdk-runtime` is the host-level SDK for running agent harnesses
behind one runtime facade. An agent harness is the agent application/control
surface that executes a turn: Claude, Codex, Cursor, OpenCode, or Pi.

Most products should start with `createAgentRuntime()`. Use
`@claxedo/workspace-runtime` when you want the HTTP server product instead of an
embedded SDK.

```ts
import { createAgentRuntime } from "@claxedo/agent-sdk-runtime"
import { claude, pi } from "@claxedo/agent-sdk-runtime/harnesses"
import { createSqliteRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/sqlite"

const runtime = createAgentRuntime({
  store: createSqliteRuntimeStore({ root: ".agent-runtime" }),
  harnesses: [claude({ access: "native" }), pi()],
})

const session = await runtime.sessions.create({
  directory: "/repo",
  harness: { id: "claude", access: "native" },
  title: "Review",
})

const events = runtime.events.subscribe({ sessionId: session.id })
await runtime.turns.start({ sessionId: session.id, text: "review this repo" })
```

## Mental Model

The package separates three choices:

| Concept | Meaning |
| --- | --- |
| `harness.id` | Which agent harness executes the turn: `claude`, `codex`, `cursor`, `opencode`, or `pi`. |
| `harness.access` | How the host talks to that harness: `acp` for Agent Client Protocol, or `native` for the harness's native API/runtime. |
| `model` | The prompt model to request. This is separate from harness access because model provider is not the same thing as harness. |

Among the built-ins, only `claude`, `codex`, and `cursor` support
`access: "acp"`; `opencode` and `pi` are native-only. Beyond the built-ins,
`access: "acp"` is an open surface: any id matching the connection-slug
pattern (`^[a-z][a-z0-9-]{0,63}$`) names an operator-configured ACP agent,
carried under the canonical key `acp:<slug>` (`SessionHarnessId` widens
`AgentHarnessId` for this). Its process descriptor — command, arguments, and
environment — arrives only through the host's trusted config path, never from
session callers. See
[Operator-Configured ACP Connections](./acp-connections.md).

`provider` remains valid for model providers, credential providers, sandbox
providers, and upstream protocol fields. It should not be used for the harness
that owns a turn.

Session liveness and turn outcome are separate:

| Field | Meaning |
| --- | --- |
| `session.status` | Current runtime liveness: `busy`, `recovering`, `error`, or idle/null. It is not `done`. |
| `session.lastTurn.status` | Durable most recent turn result: `completed`, `failed`, or `cancelled`. |
| `session.lastTurn.assistantMessageId` | Assistant message row id for the settled turn, useful for correlating a prompt with its outcome. |

Render turn-level Done, Failed, and Cancelled from `lastTurn`, not from
`message.time.completed`. Message completion is about one assistant row; turn
outcome is recorded by the runtime after Claude SDK, Codex app-server, ACP,
OpenCode, or Pi terminal signals settle. If the host also tracks a higher-level
goal or task lifecycle, use that lifecycle for session-level working/done state.
CLI hook integrations are for terminal lifecycle visibility, not canonical SDK
turn outcome.

## Session Config

```ts
type SessionConfig = {
  harness: SessionHarness
  model?: PromptModel
  variant?: string | null
  agent?: string | null
}

type SessionHarness = {
  id: "claude" | "codex" | "cursor" | "opencode" | "pi"
  access: "acp" | "native"
  connection?: HarnessConnection
}
```

`connection` contains transport details:

```ts
type HarnessConnection =
  | { kind: "process"; binary?: string; args?: string[] }
  | {
      kind: "remote"
      transport?: "stdio" | "streamable-http" | "websocket"
      url?: string
      headers?: Record<string, string>
    }
```

Put model choice in `SessionConfig.model`, not inside `harness.connection`.

## Harness Factories

| Import | Factory |
| --- | --- |
| `@claxedo/agent-sdk-runtime/harnesses` | `claude`, `codex`, `cursor`, `opencode`, `pi` |

Factories register harnesses with `createAgentRuntime()`. Adapter classes are
an advanced, lower-level public API exported from
`@claxedo/agent-sdk-runtime/adapters`, for hosts that need lower-level driver
control such as a workspace host, compatibility proxy, or custom harness
integration.

## Stores

First-party stores are explicit subpath exports:

- `@claxedo/agent-sdk-runtime/stores/memory`
- `@claxedo/agent-sdk-runtime/stores/sqlite`
- `@claxedo/agent-sdk-runtime/stores/convex`

The root import does not load SQLite or Convex.

## Event Delivery

At the runtime layer, `turns.start()` starts work and `events.subscribe()`
streams updates. Subscriber failures are isolated so one listener cannot block
later listeners.

SSE endpoints should use `attachSseFanout` for subscription, heartbeat, and
teardown behavior unless they intentionally need different semantics.

## Package Docs

The package-local docs are the canonical API and recipe source:

- `packages/agent-sdk-runtime/docs/concepts.md`
- `packages/agent-sdk-runtime/docs/api.md`
- `packages/agent-sdk-runtime/docs/recipes.md`

## Grounding

Implemented in:

- `packages/agent-sdk-runtime/src/index.ts`
- `packages/agent-sdk-runtime/src/harness-types.ts`
- `packages/agent-sdk-runtime/src/harnesses/index.ts`
- `packages/agent-sdk-runtime/src/runtime.ts`
- `packages/agent-sdk-runtime/src/stores/*`
- `packages/agent-sdk-runtime/src/sse.ts`
