# Sync Architecture (Current Implementation)

Last verified against code: 2026-03-24

This document describes what is implemented in `claxedo-server` today.  
It is aligned with `sync-architecture-target.md` terminology so we can move without doc drift.

## Scope

This covers session metadata, cloud session caching, message replay, PTY lifecycle handling, event fanout, and process config storage in:

- `packages/claxedo-server/src/routes/agent-session.ts`
- `packages/claxedo-server/src/session-meta.ts`
- `packages/claxedo-server/src/cloud/session-sync.ts`
- `packages/claxedo-server/src/cloud/message-replay.ts`
- `packages/claxedo-server/src/proxy.ts`
- `packages/claxedo-server/src/workspace-supervisor.ts`
- `packages/claxedo-server/src/routes/events.ts`
- `packages/claxedo-server/src/routes/pty.ts`
- `packages/claxedo-server/src/pty/index.ts`
- `packages/workspace-runtime/src/routes/session-core.ts`

## Current Data Model

Current central layer in this package is SQLite (`ClaxedoDB`) with multiple tables:

- `claxedo_session_meta`: normalized session metadata (title, parent, archived, workspace/project linkage)
- `claxedo_session_tag`: session tags
- `claxedo_session_attachment`: session attachments
- `claxedo_cloud_session`: cached cloud session summaries
- `claxedo_cloud_message`: persisted message replay data

Current status versus target:

- This is effectively `SQLiteSyncDB` behavior, but no explicit `SyncDB` abstraction is implemented yet.
- SQLite is in-app/local today.
- Remote/cloud-backed metadata store is not active yet.
- PTY metadata is not in central SQLite yet.

## Locality Envelope (Planned, Not Fully Applied Yet)

Target fields for runtime-bound entities:

- `workspace_id`
- `runtime_kind` -> `local | cloud`
- `runtime_url` -> nullable; required when `runtime_kind=cloud`
- `runtime_id` -> nullable runtime/sandbox identifier

Current state:

- locality exists implicitly in several paths (workspace kind/directory/proxy route), not as one consistent envelope on all entity rows.

## Current Request Flows

### 1) Local Session CRUD (`/session*`)

Local session routes are handled by `AgentSessionRoutes`, which uses `createSessionRoutes()` hooks:

- `afterListSessions` -> `syncSessionMetas` + `syncCloudSessions`
- `afterCreateSession` -> `syncSessionMeta` + `syncCloudSession`
- `afterGetSession` -> `syncSessionMeta` + `syncCloudSession`
- `afterUpdateSession` -> `syncSessionMeta` + `syncCloudSession`
- `afterDeleteSession` -> `deleteSessionMeta` + `deleteCloudSession`
- `afterMessages` -> `syncCloudMessages`

Important behavior:

- Hook failures are swallowed by `session-core` (`after()` catches errors), so sync is best-effort and does not fail the request response path.

### 2) Cloud Workspace Requests

Cloud workspace traffic is routed through `workspaceRuntimeProxy` in `proxy.ts`.

- `/session`, `/permission`, `/question`, `/event`, `/find`, `/mcp`, and process/diff/tunnel paths are proxied to workspace-runtime.
- The proxy currently forwards responses and does not parse non-streaming `/session*` response bodies for metadata extraction.

### 3) Message Read/Write Behavior

Messages are persisted in `claxedo_cloud_message` today.

- Streaming message events (`message.updated`, `message.part.updated`) are persisted by `subscribeMessageReplay(globalBus)`.
- This subscription is installed in `startServer()`.
- `GET /session/:id/message` in `AgentSessionRoutes` first serves replay data from DB (`readSessionMessages`) when present; otherwise it falls back to adapter fetch.

So message history is already persisted in central SQLite, but is still event-derived and fallback-based (not yet strict canonical read semantics).

### 4) Event Fanout

Global event fanout is implemented as:

- local session events -> `globalBus.publish(...)` in `AgentSessionRoutes.publishGlobal`
- cloud runtime global SSE (`/global/event`) -> bridged by `workspace-supervisor.streamGlobal(...)` -> `globalBus`
- clients subscribe via SSE endpoint `/global/event` in `routes/events.ts`

### 5) PTY Reality (Current)

PTY runtime state today:

- active PTY sessions are maintained in-memory (`Pty.sessions` map in `src/pty/index.ts`)
- local disk history is maintained via PTY history helpers (`history-disk`)
- PTY lifecycle events (`pty.created`, `pty.updated`, `pty.exited`, `pty.deleted`, `pty.stream`) are published on `claxedoBus`

What is not implemented today:

- central DB table for PTY metadata
- cross-device PTY restore policy in metadata layer
- explicit local-vs-cloud PTY restore semantics in sync layer

## Session Listing Composition

`/experimental/session` builds a merged view from multiple sources in `opencode-compat.ts`:

- local session listing
- remote runtime session listing
- `claxedo_cloud_session` rows (excluding deleted)
- then applies extra metadata via `applySessionMeta(...)`

This is a merged/cached read path, not a single canonical-source read.

## Process Config Reality

Process configs are file-based today:

- source of truth: `.opencode/processes.jsonc` in each workspace/project directory
- loaded/saved in `src/process/index.ts`
- changes emit `process.config.changed` on `claxedoBus`

There is no implemented central process-definition table yet; target direction is to centralize definitions and derive workspace/runtime view dynamically.

## Consistency and Failure Semantics (Current)

- Session metadata and cloud cache updates are asynchronous hook side effects.
- Sync errors do not currently fail session CRUD responses because hook errors are absorbed.
- Message replay writes happen via event stream subscription; replay depends on event delivery.
- This is eventual consistency inside the control plane, not strict write-before-respond guarantees.

## Source of Truth Matrix (Current)

| Entity | Canonical write owner | Read path | Notes |
|--------|------------------------|-----------|-------|
| Session metadata (`title`, `archived`, lineage, tags, attachments) | Local session/runtime write path + metadata routes | `session-meta` tables + `applySessionMeta(...)` composition | Best-effort sync hooks can lag; metadata may temporarily trail runtime response. |
| Cloud session summary cache | `syncCloudSession(s)` hook writes | `opencode-compat` session merge path | Cache-like role; merged with runtime/local sources. |
| Message history replay | `globalBus` message event subscriber (`subscribeMessageReplay`) | `GET /session/:id/message` replay-first fallback-to-adapter | Replay is event-derived; gaps are possible if event delivery fails. |
| PTY metadata | In-memory PTY runtime (`src/pty/index.ts`) | PTY routes + events fanout | No central DB sync yet; local disk history exists, cross-device behavior not modeled in DB. |
| Process definitions | Workspace file `.opencode/processes.jsonc` | `ProcessManager.configs(...)` / process routes | Not centrally synchronized in current implementation. |

Rule: do not introduce a second writable owner for any row/object without updating this table and documenting conflict handling.

## Consistency SLOs and Repair Targets (Proposed for Current System)

These are operational targets for the current architecture, not hard transactional guarantees:

- Session metadata visibility lag (local CRUD -> merged session list): target P95 <= 2s.
- Message replay lag (`message.updated` event -> replay read availability): target P95 <= 1s.
- Replay fallback rate (DB replay miss requiring adapter fetch): target <= 1% of message reads over 1h.
- Silent sync failure budget (hook/subscriber errors with no successful retry): target 0 unresolved errors > 10m.

Recommended repair behavior:

- Periodic backfill on active workspaces: refresh session summaries on interval and on reconnect.
- On replay miss for a known live session: serve adapter result and enqueue replay repair write.
- On repeated sync hook failure: emit structured error with workspace/session ids and raise alert.

## Observability Contract (Needed to Operate This Design)

Required metrics:

- `sync_hook_total{hook,result}` for each session hook path.
- `session_meta_lag_ms` sampled from runtime update time to merged-list visibility.
- `message_replay_write_total{result,type}` for replay persistence.
- `message_replay_read_total{source}` where source in `{replay,adapter_fallback}`.
- `session_merge_source_total{source}` where source in `{local,remote_runtime,cloud_cache}`.

Required structured log fields on sync/replay errors:

- `workspace_id`
- `session_id`
- `message_id` (when applicable)
- `route`
- `error_class`
- `retry_count`

Recommended alerts:

- Replay fallback rate > 5% for 10m.
- Any sustained sync hook error rate > 1% for 10m.
- Metadata lag P95 > 10s for 10m.

## Not Implemented Yet (Commonly Assumed, But Not Present)

The following are not implemented in current code:

- explicit `SyncDB` abstraction with pluggable backends (SQLite is currently embedded directly)
- remote `SyncDB` adapter (for example Convex-backed metadata store)
- proxy body interception for cloud `/session*` responses to trigger sync
- centralized PTY metadata table and sync writes
- PTY restore policy in sync layer (`local` = never recreate, `cloud` = reconnect when possible)
- centralized process definitions (`process_definitions`) as canonical source
- centralized pages/workgraph/config metadata tables as canonical source
- one-time local -> cloud session handoff pipeline is not required for default message continuity model
- strict requirement that sync persistence must succeed before HTTP response is returned

## Near-Term Alignment Plan (Current -> Target)

Immediate focus:

1. Introduce `SyncDB` interface and route existing SQLite writes through it (no behavior change).
2. Keep SQLite as default backend in-app.
3. Expand central SQLite coverage for entities called out in target doc (messages, PTY metadata, process defs, pages, workgraph, config metadata).
4. Add shadow-write path for remote backend later, with feature-flagged read cutover.

Doc ownership rule:

- Keep this file strictly as-built.
- Keep future behavior in `sync-architecture-target.md`.
