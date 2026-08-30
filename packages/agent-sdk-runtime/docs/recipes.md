# Host Integration Recipes

Build one realtime agent host API, then run it against Codex app server,
Claude, Cursor, OpenCode, ACP harnesses, or Pi.

`@claxedo/agent-sdk-runtime` is for backend engineers building agent products.
It gives you one host-facing runtime contract:

```text
client app
  -> your backend
  -> AgentRuntime
  -> harness factory
  -> Codex / Claude / Cursor / OpenCode / Pi
  -> runtime events
  -> your realtime UI and database
```

The package owns harness runtime mechanics. Your app still owns auth,
workspaces, tenancy, storage, sharing, billing, route shape, and UI state.

## Pick Your Path

| If you want to... | Start here |
| --- | --- |
| see the package work with no external agent setup | [1. Start One Session And Run One Turn](#1-start-one-session-and-run-one-turn) |
| wire a backend route and realtime subscription | [2. Turn It Into A Realtime App Loop](#2-turn-it-into-a-realtime-app-loop) |
| let users choose Codex, Claude, Cursor, OpenCode, or Pi | [3. Switch Harnesses Without Changing Host Code](#3-switch-harnesses-without-changing-host-code) |
| approve permissions or answer harness questions | [4. Handle Permissions And Questions](#4-handle-permissions-and-questions) |
| change models, auth, MCP, or config options | [5. Configure Models And Runtime Settings](#5-configure-models-and-runtime-settings) |
| persist sessions and replay output | [6. Add Durable Host Storage](#6-add-durable-host-storage) |
| split reasoning from file/command execution | [7. Run Brain And Hands In Different Places](#7-run-brain-and-hands-in-different-places) |
| choose ACP, native SDK, OpenCode HTTP, or Pi | [8. Choose An Integration Strategy](#8-choose-an-integration-strategy) |
| build a sidebar/history view | [9. List And Project Sessions](#9-list-and-project-sessions) |

## 1. Start One Session And Run One Turn

Use this when you want the smallest working proof: create a session, send a
prompt, and see events.

Before you start:

- No Claude/Codex/Cursor credentials are required.
- This uses Pi with `createVirtualSessionEnv()` so the example is local and
  deterministic.
- For real model-backed runs, switch to a Claude/Codex/Cursor/OpenCode harness
  later using the same host loop.

```ts
import { createAgentRuntime } from "@claxedo/agent-sdk-runtime"
import { pi } from "@claxedo/agent-sdk-runtime/harnesses"
import { createMemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import { createVirtualSessionEnv } from "@claxedo/agent-sdk-runtime/virtual-session-env"

function createEnv() {
  return createVirtualSessionEnv({
    cwd: "/workspace",
    files: { "/workspace/README.md": "hello from the runtime\n" },
  })
}

const runtime = createAgentRuntime({
  store: createMemoryRuntimeStore(),
  harnesses: [pi({ createEnv })],
})

const session = await runtime.sessions.create({
  directory: "/workspace",
  harness: { id: "pi", access: "native" },
  model: { providerID: "pi", modelID: "virtual" },
  title: "First session",
})

const events = runtime.events.subscribe({ sessionId: session.id })

await runtime.turns.start({
  sessionId: session.id,
  text: "exec: cat README.md",
})

for await (const event of events) {
  console.log(event.payload.type)
  if (event.payload.type === "finish") break
}
```

You should see:

```text
message.updated
message.part.updated
session-status
text-delta
session-status
finish
```

Next: keep this host loop and swap the harness.

After the stream settles, read the session projection for durable turn outcome:

```ts
const projected = await runtime.sessions.get(session.id)

if (projected?.lastTurn?.status === "completed") {
  console.log("turn completed")
}
```

Keep `session.status` for live liveness such as Running or Recovering. Use
`session.lastTurn` for turn-level Done, Failed, or Cancelled. Do not infer Done
from `message.time.completed`; that timestamp belongs to an assistant message
row, not the whole harness turn.

When reconciling a currently submitted prompt, also compare
`session.lastTurn.assistantMessageId` with the assistant row id for that prompt.
`lastTurn.status` alone can describe a previous turn on the same reusable
session. If your host supports a higher-level lifecycle such as a Codex goal,
keep using that lifecycle for session-level working/done state; a turn can
settle while the goal continues.

## 2. Turn It Into A Realtime App Loop

Use this when you have a mobile or web app and a backend.

The important split:

- the prompt route calls `runtime.turns.start()`
- your backend or client subscribes through `runtime.events.subscribe()`
- the client subscribes through SSE, WebSocket, or your realtime system

Do not teach the client to talk directly to a harness process.

The in-process event hub and SSE replay helpers are local runtime primitives.
That is the intended shape when each session is pinned to one owner machine:
the machine's durable session/message log is the source of truth, and the
in-memory bus is only the live notification layer for currently connected
clients. On reconnect, refetch or replay from the owner machine's durable
store.

Use an external pub/sub layer only if your host allows the same session to be
served live from multiple processes or machines.

```ts
import type { AgentRuntime, AgentRuntimeTurnStartInput } from "@claxedo/agent-sdk-runtime"

type EventBus = {
  publish(event: unknown): Promise<void>
}

type SubmitPromptInput = {
  runtime: AgentRuntime
  bus: EventBus
  turn: AgentRuntimeTurnStartInput
}

export async function submitPrompt(input: SubmitPromptInput) {
  const events = input.runtime.events.subscribe({ sessionId: input.turn.sessionId })
  await input.runtime.turns.start(input.turn)

  for await (const event of events) {
    await input.bus.publish(event)
    if (event.payload.type === "finish" || event.payload.type === "session.error") break
  }
}
```

For a turn-level session list or detail header, derive display state from both
fields:

```ts
import type { AgentSession } from "@claxedo/agent-sdk-runtime"

export function sessionLabel(session: AgentSession, messageCount: number) {
  if (session.status === "busy") return "Running"
  if (session.status === "recovering") return "Recovering"
  if (session.lastTurn?.status === "completed") return "Done"
  if (session.lastTurn?.status === "failed") return "Failed"
  if (session.lastTurn?.status === "cancelled") return "Cancelled"
  if (messageCount === 0) return "New"
  return "Idle"
}
```

If this session is inside a long-running goal or task, check that lifecycle
first and keep showing "Running" until the goal itself completes.

If you use `@claxedo/workspace-runtime`, this shape is already implemented:

```text
POST /session/:id/message  -> runs the turn
GET  /event                -> client-facing SSE subscription
```

Next: let the same route choose different harnesses.

## 3. Switch Harnesses Without Changing Host Code

Use this when your UI has a picker for Codex, Claude, Cursor, OpenCode, or Pi.

The product choice becomes `SessionConfig`:

```ts
const config = {
  harness: { id: "claude", access: "native" },
  model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
  agent: "default",
  variant: null,
} as const
```

Your backend registers available harnesses once. The per-session choice remains
data.

```ts
import { createAgentRuntime } from "@claxedo/agent-sdk-runtime"
import { claude, codex, cursor, opencode, pi } from "@claxedo/agent-sdk-runtime/harnesses"
import { createSqliteRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/sqlite"

const runtime = createAgentRuntime({
  store: createSqliteRuntimeStore({ root: ".agent-runtime" }),
  harnesses: [
    claude({ access: "native" }),
    codex({ access: "acp" }),
    cursor({ access: "native" }),
    opencode({ url: "http://127.0.0.1:4096" }),
    pi(),
  ],
})

const session = await runtime.sessions.create({
  directory: "/repo",
  ...config,
  title: "New task",
})
```

You should see the payoff: create session, submit prompt, subscribe to events,
and render UI can stay the same while the harness changes.

Next: wire the realtime interaction surfaces.

## 4. Handle Permissions And Questions

Use this when the harness asks the user or host to approve something.

A common mobile flow:

```text
harness emits permission request
  -> backend publishes it to realtime UI
  -> user taps Allow once / Always allow / Deny
  -> backend calls runtime.permissions.respond()
```

```ts
import type { AgentRuntime, AgentRuntimePermissionDecision } from "@claxedo/agent-sdk-runtime"

type AnswerPermissionInput = {
  runtime: AgentRuntime
  directory: string
  permissionId: string
  decision: AgentRuntimePermissionDecision
}

export async function answerPermission(input: AnswerPermissionInput) {
  await input.runtime.permissions.respond(input.permissionId, input.decision, input.directory)
}

type AnswerQuestionInput = {
  runtime: AgentRuntime
  directory: string
  questionId: string
  answer: string
}

export async function answerQuestion(input: AnswerQuestionInput) {
  await input.runtime.questions.answer(input.questionId, input.answer, input.directory)
}
```

Host policy still decides who is allowed to answer, whether the decision should
be audited, and whether "always allow" is legal for the workspace.

Use `HarnessCapabilities` before showing permission/question UI. The full
capability shape belongs in [api.md](./api.md#capabilities).

Next: let users update model/runtime settings safely.

## 5. Configure Models And Runtime Settings

Use this when the user changes model, auth, MCP servers, or runtime options.

There are two layers:

- `SessionConfig.model` is session-visible model selection.
- runtime config is applied through `runtime.config` so hosts do not call
  adapters directly.

```ts
import type { AgentRuntime, PromptModel } from "@claxedo/agent-sdk-runtime"

type ChangeModelInput = {
  runtime: AgentRuntime
  sessionId: string
  model: PromptModel
}

export async function changeModel(input: ChangeModelInput) {
  await input.runtime.config.update(input.sessionId, { model: input.model })
}
```

Changing model is not the same as changing harness. A session that started on
Claude should not silently become a Codex session unless your host implements a
restart or migration flow.

Next: persist enough state to survive reloads and process recovery.

## 6. Add Durable Host Storage

Use this when SDK or ACP harnesses need durable sessions, replay, recovery, or
a mapping from your public session id to the harness-native session id.

The host chooses the store implementation. The runtime uses it as the
authoritative projection for public ids, configuration, normalized events,
interactions, recovery, and handoff state.

Minimum store responsibilities:

| Store area | Why it exists |
| --- | --- |
| sessions | list, read, update, delete host-visible sessions |
| bindings | map host session ids to harness-native session ids |
| config | remember `SessionConfig` between turns |
| turns/events | replay messages and recover after reconnect |
| interactions | store pending permissions, questions, and todos |
| recovery | mark sessions recovering after interruption |

```ts
import { createSqliteRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/sqlite"
import { createConvexRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/convex"

const localStore = createSqliteRuntimeStore({ root: ".agent-runtime" })
const convexStore = createConvexRuntimeStore({
  workspaceId,
  auth,
  authority,
})
```

The SQLite store commits normalized rows synchronously. Harness-native storage
may contain the provider conversation, but it does not contain the complete
runtime projection listed above.

Custom stores are advanced integration work. Start with a first-party store.

Next: run the agent brain in one place and its hands somewhere else.

## 7. Run Brain And Hands In Different Places

Use this when reasoning/control runs centrally, but file and command execution
happens in a local workspace, remote workspace, sandbox, or virtual
environment.

This is what `SessionEnv` is for.

```ts
import type {
  SessionEnv,
  SessionEnvFactoryInput,
} from "@claxedo/agent-sdk-runtime/session-env"
import { pi } from "@claxedo/agent-sdk-runtime/harnesses"
import { createVirtualSessionEnv } from "@claxedo/agent-sdk-runtime/virtual-session-env"

type PlacementInput = {
  sessionId: string
  directory: string | undefined
}

function createHands(input: SessionEnvFactoryInput): SessionEnv {
  const cwd = input.directory ?? "/workspace"

  return createVirtualSessionEnv({
    cwd,
    files: {},
  })
}

function placeSession(input: PlacementInput) {
  return {
    mode: "hybrid" as const,
    host: "central" as const,
    directory: input.directory,
    toolSandbox: { kind: "virtual" as const, id: input.sessionId },
  }
}

export const piHarness = pi({
  createEnv: createHands,
  defaultPlacement: placeSession,
})
```

Native Claude, Codex, and Cursor adapters may own workspace access through
their upstream SDK or app server. `SessionEnv` matters most when the harness
delegates workspace operations back to your host.

Next: choose the integration mechanism for each harness.

## 8. Choose An Integration Strategy

Use this when deciding how your backend should reach each harness.

| Strategy | Use when |
| --- | --- |
| ACP | the harness is exposed through Agent Client Protocol |
| native SDK/app server | you want the harness-specific local integration |
| OpenCode HTTP | an OpenCode server owns the HTTP runtime |
| Pi | you want the built-in host-driven harness |

ACP:

```ts
import { acp } from "@claxedo/agent-sdk-runtime/harnesses"

const openClaw = acp("openclaw", {
  binary: "openclaw-acp",
  args: ["serve"],
})
```

Native Codex app server:

```ts
import { codex } from "@claxedo/agent-sdk-runtime/harnesses"

const codexNative = codex({
  access: "native",
  binary: "codex",
})
```

OpenCode HTTP:

```ts
import { opencode } from "@claxedo/agent-sdk-runtime/harnesses"

const opencodeHarness = opencode({ url: "http://127.0.0.1:4096" })
```

Pi:

```ts
import { pi } from "@claxedo/agent-sdk-runtime/harnesses"

const piHarness = pi()
```

OpenCode's `http-proxy` adapter capability means selected compatibility routes
may use the backing server. It does not mean your product should expose every
OpenCode route.

Next: build sidebar/history and app-owned projections.

## 9. List And Project Sessions

Use this when your app needs a sidebar, history screen, search index, or
workspace-level session list.

`listSessions()` lists sessions known to the adapter or host store for that
directory. It does not discover arbitrary sessions created outside this
package.

```ts
import type { AgentRuntime, RuntimeDirectory } from "@claxedo/agent-sdk-runtime"

type ListSidebarSessionsInput = {
  runtime: AgentRuntime
  directory: RuntimeDirectory
}

export async function listSidebarSessions(input: ListSidebarSessionsInput) {
  const sessions = await input.runtime.sessions.list(input.directory)

  return sessions.map((session) => ({
    id: session.id,
    title: session.title ?? "Untitled session",
    updatedAt: session.time?.updated ?? session.created_at,
  }))
}
```

Projection belongs to the host:

```ts
type ProjectRuntimeEventInput = {
  sessionId: string
  event: unknown
}

export async function projectRuntimeEvent(input: ProjectRuntimeEventInput) {
  const row = {
    sessionId: input.sessionId,
    payload: input.event,
    createdAt: Date.now(),
  }

  await db.runtimeEvents.insert(row)
}
```

Filter session lists by workspace, organization, sharing rules, and current
user permission before returning them to a client.

## Production Checklist

Before exposing this in a product, decide these in your host:

- who can create sessions in each workspace
- which harnesses each user/workspace may use
- how credentials are stored and scoped
- how session operations and subscriptions route back to the owner machine
- which local durable log/store is the source of truth for replay
- whether you need external pub/sub for non-sticky or multi-process serving
- where commands execute and how files are sandboxed
- how permissions are approved, denied, audited, and expired
- how streamed events are replayed after reconnect
- how sessions are listed, shared, archived, and deleted
- which compatibility routes are exposed
- how harness interruption and recovery appear to users

The SDK stays small by design: runtime mechanics here, product policy in your
host.
