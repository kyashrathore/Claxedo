# Agent SDK Runtime

`@claxedo/agent-sdk-runtime` carries the shared runtime types and helpers that
Claxedo's hosts, clients and workspace runtime agree on: session and prompt
shapes, the client-presentation (compat) event bridge, provider credential
projections, session config helpers, and the durable store contract. Harness
transports and the runtime host that drives them live in `@claxedo/harness` and
`@claxedo/workspace-runtime`; this package no longer starts, attaches to or
prompts any harness.

## Install

```sh
npm install @claxedo/agent-sdk-runtime
```

```ts
import { admitSessionInstructions, resolveSessionModel, type SessionConfig } from "@claxedo/agent-sdk-runtime"
import { messageUpdated, toCompatEvent } from "@claxedo/agent-sdk-runtime/compat-events"
import { providerProjectionRecord } from "@claxedo/agent-sdk-runtime/provider-projection"
import { createSqliteRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/sqlite"
```

## Entrypoints

| Entrypoint | Holds |
| --- | --- |
| `@claxedo/agent-sdk-runtime` | Harness identity tables, `SessionConfig`/`PromptInput` helpers (`resolveSessionModel`, `resolveTurnSystem`, `admitSessionInstructions`, session title bounds), permission ceilings, provider projections, first-turn error classes, and the shared host-visible types re-exported from `@claxedo/agent-runtime-contract`. |
| `./compat-events` | The client-presentation event shapes (`message.updated`, `session.idle`, …) and the builders that turn canonical runtime events into them. |
| `./status` | Session status normalisation (`live`, `chunk`, `recovering`). |
| `./provider-projection` | Provider credential projections and the record validator applied to pushed rows. |
| `./message-page` | Bounded transcript-page contracts and `projectLatestSurfaceMessages`. |
| `./adapters` | The durable store contract (`AgentRuntimeStoreWithRecovery` and its row types), recovery scope helpers, `AgentRuntimeStaleTurnError`, goal capability helpers and `AgentMessagePageError`. |
| `./stores/memory`, `./stores/sqlite`, `./stores/session-start` | Store implementations for tests and ephemeral hosts; the workspace runtime's own `RuntimeStore` is the durable production store. |

## Store contract

`AgentRuntimeStoreWithRecovery` (`./adapters`) is what the workspace runtime's
host reads and writes: sessions, execution bindings, session config, turn
leases and fencing tokens, committed compat events, recovery operations, todos
and pending requests. `MemoryRuntimeStore` and `SqliteRuntimeStore` implement
it for tests; both refuse a turn finalisation whose lease is not the one the
session holds (`AgentRuntimeStaleTurnError`).

## Session config helpers

- `resolveSessionModel(config)` and `resolveTurnSystem(config, channel, turnSystem)` decide the model and system block one turn runs with.
- `admitSessionInstructions({ channel, instructions, harness })` refuses a retained instruction block a harness cannot carry or that exceeds `SESSION_INSTRUCTIONS_MAX_BYTES`.
- `acceptsSessionTitle` / `boundSessionTitleSource` say when a writer may replace a session's title.
- Permission ceilings: `permissionModeLevel`, `permissionCeilingAdmits`, `narrowerPermissionLevel`, `widestPermissionModeUnder`.

## Docs

`docs/agent.md` is the entry for a coding agent; `docs/concepts.md`,
`docs/architecture.md`, `docs/boundaries.md`, `docs/api.md` and
`docs/recipes.md` follow from it. `docs/api-manifest.json` is the reviewed
public API; `bun run check:api-manifest` verifies it and `bun run verify:publish`
builds `dist/` and checks declaration hashes before a publish.
