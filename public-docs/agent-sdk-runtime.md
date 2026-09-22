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

Provider-owned agents are identified by the discriminated target
`{ kind: "connection", connectionId }`. Native agents use
`{ kind: "native", harnessId }`. Connection ids remain opaque: callers do not
prefix or parse them, and process descriptors arrive only through the host's
trusted v3 config path. Browser surfaces receive only sanitized
`HarnessConnectionRef` values. See [Agent Connections](./acp-connections.md).

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
  id: "claude" | "codex" | "cursor" | "pi" | (string & {})
  access: "connection" | "native"
}
```

Native ids are closed. An open id is valid only with `access: "connection"`
and must resolve through the host's accepted provider registry. Transport
details and secrets remain in the trusted connection descriptor, not the
session:

```ts
type RuntimeHarnessSelection =
  | { kind: "native"; harnessId: "claude" | "codex" | "cursor" | "pi" }
  | { kind: "connection"; connectionId: string }
```

Put model choice in `SessionConfig.model`, not inside `harness.connection`.

## Harness Factories

| Import | Factory |
| --- | --- |
| `@claxedo/agent-sdk-runtime/harnesses` | `claude`, `codex`, `cursor`, `pi` |

Factories register harnesses with `createAgentRuntime()`. Adapter classes are
an advanced, lower-level public API exported from
`@claxedo/agent-sdk-runtime/adapters`, for hosts that need lower-level driver
control such as a workspace host, compatibility proxy, or custom harness
integration.

## Stores

First-party stores are explicit subpath exports:

- `@claxedo/agent-sdk-runtime/stores/memory`
- `@claxedo/agent-sdk-runtime/stores/sqlite`

The root import does not load SQLite.

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
- `packages/agent-runtime-contract/src/harnesses.ts`
- `packages/agent-sdk-runtime/src/harnesses/index.ts`
- `packages/agent-sdk-runtime/src/runtime.ts`
- `packages/agent-sdk-runtime/src/stores/*`
- `packages/agent-sdk-runtime/src/sse.ts`
