# Architecture

The runtime is the single owner of host-visible session state. Harness adapters
own protocol execution; stores own durable projection; hosts own product policy.

## Turn flow

```text
Host calls runtime.turns.start()
  -> runtime admits one active turn for the session
  -> runtime reads the persisted SessionConfig
  -> runtime resolves exactly that harness adapter
  -> store.startTurn() commits the user and assistant rows
  -> adapter executes the native or ACP turn
  -> projector normalizes harness frames
  -> store.appendEvent() commits each compatibility event
  -> runtime publishes committed events to bounded subscribers
  -> store.finishTurn() commits the durable outcome
```

No layer invents a missing session, config, interaction owner, model list, or
terminal event. Missing contracts are reported to the caller.

## Ownership

| Concern | Authoritative owner |
| --- | --- |
| session inventory and config | runtime store |
| native process and protocol state | harness adapter |
| turn admission and harness handoff | `AgentRuntime` |
| normalized event projection | shared projector |
| model availability | live harness query, scoped by workspace directory |
| permissions and questions | session-bound adapter discovered from persisted config |
| user/org/workspace authorization | embedding host |

Both `runtime.sessions.updateConfig()` and `runtime.config.update()` call the
same runtime mutation. Adapter results are persisted before they are returned,
and harness changes use the handoff transaction.

## Persistence

The memory store is the reference state machine. SQLite extends that state
machine with normalized tables for sessions, config, messages, interactions,
todos, recovery state, event sequences, and subagent observations. Every
acknowledged mutation commits synchronously in a transaction. SQLite does not
store a delayed whole-runtime JSON snapshot.

SQLite is useful when the harness cannot be the complete host-visible source of
truth: the runtime also owns public session ids, selected harness and model,
normalized messages, pending interactions, recovery outcomes, and cross-harness
handoff state. A harness may persist its own native conversation, but that data
does not replace the runtime projection.

## Process and stream lifecycle

ACP process management and turn execution are separate modules. Native SDK
drivers share session, projection, and interaction behavior while keeping auth
and protocol I/O in harness-specific files.

Each runtime subscriber has a fixed buffer. A slow subscriber receives a
`runtime.subscription_overflow` notice and closes. After reconnecting, it
reloads the authoritative runtime projections. When the host provides
`eventDelivery`, authorization is checked against the subscriber identity
before each queued event is returned. Lazy
adapter resolution is single-flight per harness identity.

## Package boundaries

Use the root entry for runtime contracts, explicit store entries for storage,
and per-harness factory entries when only one harness is needed:

```ts
import { createAgentRuntime } from "@claxedo/agent-sdk-runtime"
import { claude } from "@claxedo/agent-sdk-runtime/harnesses/claude"
import { createSqliteRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/sqlite"
```

The build externalizes package dependencies, shares internal chunks, validates
the API manifest, imports every public entry, and enforces bundle-size limits.
