# Workspace Runtime Architecture

## Goal

`workspace-runtime` lets the existing opencode-compatible frontend talk to either:

- a real opencode server over HTTP/SSE
- an ACP agent process over stdio

The runtime owns one target only:

- one WR process per directory today
- one WR process per VM tomorrow

Multi-directory fanout is intentionally not supported.

## Runtime Model

```text
frontend
  -> claxedo-server
    -> workspace-runtime
      -> OpenCodeAdapter -> opencode /global/event + session routes
      -> ACPAdapter -> ACP stdio
```

In the current implementation, `claxedo-server` only forwards runtime-owned paths to WR for cloud workspaces. Control-plane routes stay on `claxedo-server`.

The target directory is pinned at process start via `CLAXEDO_WR_DIRECTORY`.

- exactly one directory is allowed
- comma-separated values are rejected at boot
- all target-aware routes validate that the requested directory matches the pinned one

The runtime identity is `workspaceId`.

- `CLAXEDO_WR_WORKSPACE_ID` is used when provided
- otherwise WR creates one process-stable fallback ID
- the ID refers to the single WR target, not a set of directories

## Event Contract

WR’s shared internal and external protocol is `CompatEvent`.

- it is a typed union built from generated `@opencode-ai/sdk` event types
- canonical event names are enforced in code and in `bun typecheck`
- adapters are not allowed to construct arbitrary `{ type: string }` payloads

Canonical live events include:

- `message.updated`
- `message.part.updated`
- `message.part.delta`
- `permission.asked`
- `permission.replied`
- `question.asked`
- `question.replied`
- `question.rejected`
- `todo.updated`
- `session.status`
- `session.idle`
- `session.error`
- `session.updated`

WR keeps a few explicit extension events for local compat/state needs:

- `message.completed`
- `session.todo`
- `session.agent`
- `session.config`
- `session.usage`
- `server.connected`
- `server.heartbeat`

## Translation Rules

### OpenCode mode

`OpenCodeAdapter` treats opencode as the source of truth.

- `POST /session/:id/message` starts the turn
- `/global/event` is parsed as canonical compat events
- matching session events are forwarded unchanged
- `/session/:id/todo` proxies upstream todo state instead of inventing local state

### ACP mode

`ACPAdapter` translates ACP session updates into canonical compat events.

The old shared `UIMessageChunk` language still exists only as a local ACP translation step:

- ACP `SessionUpdate` -> `UIMessageChunk`
- `UIMessageChunk` -> `CompatEvent`
- routes and the global bus work with `CompatEvent`

That means the shared contract is no longer chunk-shaped.

### Streaming behavior

Live partial output is streamed as deltas.

- first chunk for a text/reasoning part emits `message.part.updated`
- subsequent incremental content emits `message.part.delta`
- durable state is reconstructed by applying deltas to stored parts

This avoids route-local “latest full text” accumulation becoming the protocol.

## Persistence Model

ACP-backed state is journal-first.

- authoritative storage lives under `~/.claxedo/workspace-runtime/`
- each WR session has an append-only JSONL journal at `sessions/<sessionId>.jsonl`
- SQLite is a rebuildable projection, not the source of truth

Journal rows store:

- `seq`
- `ts`
- WR session ID
- ACP session ID when known
- row kind: control or event
- optional source metadata for ACP traffic
- raw compat payload or WR control payload

Projection tables:

- `session`
- `session_map`
- `message`
- `part`
- `todo`
- `pending_permission`
- `pending_question`
- `journal_checkpoint`

Control rows currently include:

- `session.bind`
- `turn.start`
- `process.lost`

The same projector logic is used for:

- live ingestion
- startup replay
- replay tests

## Recovery Semantics

On restart, WR replays journals and rebuilds the projection before serving session state.

If the ACP subprocess dies during an interactive turn:

- prior messages and todos are restored from journaled events
- pending permissions/questions are marked stale in projection
- stale permissions are not returned as actionable items
- the affected session records a recovery error
- the recovery error is emitted once on the next observed turn

WR does not try to silently recreate pending interactives. True mid-prompt resumability would require ACP reattach or external process supervision.

## Routes

The current route split is:

- `POST /session/:id/message` starts a turn and returns the final JSON reply
- `POST /session/:id/prompt_async` starts a turn and returns immediately
- `GET /session/:id/message` reads durable projected state
- `GET /session/:id/todo` reads durable projected todo state
- `GET /global/event` carries canonical live compat events
- `POST /api/wr/config` applies runtime config snapshots
- `GET /api/wr/health` reports runtime status for the pinned workspace
- `GET /api/wr/acp-config-options` probes ACP-specific config choices when ACP is active

## Verification

Production-hardening checks live in two layers:

- `bun run --cwd packages/workspace-runtime typecheck`
  - compile-time contract tests reject invalid event names like `question.created`
  - required payload fields such as `permission.asked.metadata` and `permission.asked.always` are enforced
- `bun test`
  - translator behavior
  - single-target directory enforcement
  - journal replay parity
  - stale-interactive recovery behavior

## Non-Goals

This architecture does not try to support:

- one WR process owning multiple directories
- opaque stringly-typed event construction
- in-memory-only ACP todo/question/permission state
- silent replay of pending ACP interactive prompts after process loss
